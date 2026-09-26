from __future__ import annotations

import io
import math
import random
from typing import Any

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

STYLES = {
    "سعودي حديث": ((234,229,220),(190,166,135),(95,65,45),(72,104,120),(64,58,52)),
    "نجدي حديث": ((219,195,164),(164,123,84),(86,58,40),(72,100,112),(83,59,41)),
    "حجازي حديث": ((242,230,209),(195,154,111),(93,60,42),(58,103,126),(48,82,99)),
    "مودرن فاخر": ((230,229,225),(177,173,166),(75,63,54),(55,78,90),(44,44,44)),
}

def style(name: str):
    return STYLES.get(name, STYLES["سعودي حديث"])

def mix(a,b,t):
    return tuple(int(a[i]*(1-t)+b[i]*t) for i in range(3))

def bounds(walls):
    xs,ys=[],[]
    for w in walls:
        for k in ("a","b"):
            xs.append(float(w[k]["x"])); ys.append(float(w[k]["y"]))
    return (min(xs),min(ys),max(xs),max(ys)) if xs else (0,0,1,1)

def map_pt(x,y,b,size,pad=130):
    minx,miny,maxx,maxy=b
    w,h=size
    s=min((w-2*pad)/max(maxx-minx,1),(h-2*pad)/max(maxy-miny,1))
    ox=(w-(maxx-minx)*s)/2-minx*s
    oy=(h-(maxy-miny)*s)/2-miny*s
    return x*s+ox,y*s+oy,s

def gradient(size, top, bottom):
    w,h=size
    img=Image.new("RGB",size,top)
    d=ImageDraw.Draw(img)
    for y in range(h):
        t=y/max(h-1,1)
        d.line((0,y,w,y),fill=mix(top,bottom,t))
    return img

def room_rect(room,b,size):
    cells=room.get("cells") or []
    if not cells: return None
    minx=min(float(c["x1"]) for c in cells); maxx=max(float(c["x2"]) for c in cells)
    miny=min(float(c["y1"]) for c in cells); maxy=max(float(c["y2"]) for c in cells)
    x1,y1,_=map_pt(minx,miny,b,size); x2,y2,_=map_pt(maxx,maxy,b,size)
    return x1,y1,x2,y2

def render_interior(payload: dict[str,Any], size: int=2048) -> bytes:
    wall,stone,wood,glass,accent=style(str(payload.get("style") or "سعودي حديث"))
    walls=payload.get("walls") or []; rooms=payload.get("rooms") or []; openings=payload.get("openings") or []
    furnishing=str(payload.get("furnishing") or "full")
    b=bounds(walls)
    img=Image.new("RGB",(size,size),(224,216,203))
    d=ImageDraw.Draw(img)

    for y in range(0,size,64):
        col=(226+(y//64)%2*3,218+(y//64)%2*3,205+(y//64)%2*3)
        d.rectangle((0,y,size,y+64),fill=col)

    shadow=Image.new("RGBA",(size,size),(0,0,0,0)); sd=ImageDraw.Draw(shadow)
    for w in walls:
        ax,ay,s=map_pt(float(w["a"]["x"]),float(w["a"]["y"]),b,(size,size))
        bx,by,_=map_pt(float(w["b"]["x"]),float(w["b"]["y"]),b,(size,size))
        thick=max(18,min(48,float(w.get("thickness") or 12)*s*.85))
        sd.line((ax+20,ay+22,bx+20,by+22),fill=(0,0,0,65),width=int(thick+8))
    shadow=shadow.filter(ImageFilter.GaussianBlur(18))
    img=Image.alpha_composite(img.convert("RGBA"),shadow); d=ImageDraw.Draw(img)

    for i,r in enumerate(rooms):
        rr=room_rect(r,b,(size,size))
        if not rr: continue
        x1,y1,x2,y2=rr
        floor=(226,216,202) if i%2==0 else (216,206,192)
        d.rectangle(rr,fill=floor)
        if x2-x1>220 and y2-y1>180 and i%3==0:
            d.rounded_rectangle((x1+34,y1+34,x2-34,y2-34),radius=10,fill=(178,151,120),outline=(112,82,58),width=3)

    for w in walls:
        ax,ay,s=map_pt(float(w["a"]["x"]),float(w["a"]["y"]),b,(size,size))
        bx,by,_=map_pt(float(w["b"]["x"]),float(w["b"]["y"]),b,(size,size))
        thick=max(18,min(48,float(w.get("thickness") or 12)*s*.85))
        d.line((ax,ay,bx,by),fill=mix(wall,(90,78,65),.18),width=int(thick+5))
        d.line((ax,ay,bx,by),fill=wall,width=int(thick))

    byid={str(w.get("id")):w for w in walls}
    for op in openings:
        w=byid.get(str(op.get("wallId")))
        if not w: continue
        t=float(op.get("centerT",.5))
        ax,ay,_=map_pt(float(w["a"]["x"]),float(w["a"]["y"]),b,(size,size))
        bx,by,_=map_pt(float(w["b"]["x"]),float(w["b"]["y"]),b,(size,size))
        cx=ax+(bx-ax)*t; cy=ay+(by-ay)*t; dx=bx-ax; dy=by-ay; L=max(math.hypot(dx,dy),1)
        ux,uy=dx/L,dy/L; half=max(18,float(op.get("widthM",1))*70)/2
        p1=(cx-ux*half,cy-uy*half); p2=(cx+ux*half,cy+uy*half)
        d.line((*p1,*p2),fill=glass if op.get("kind")=="window" else wood,width=16)

    if furnishing!="none":
        limit=18 if furnishing=="full" else 9
        for i,r in enumerate(rooms[:limit]):
            rr=room_rect(r,b,(size,size))
            if not rr: continue
            x1,y1,x2,y2=rr; rw=x2-x1; rh=y2-y1
            if rw<130 or rh<130: continue
            cx=(x1+x2)/2; cy=(y1+y2)/2; name=str(r.get("name") or "")
            if "نوم" in name or i%5 in (0,1):
                bw=min(210,rw*.44); bh=min(260,rh*.56)
                d.rounded_rectangle((cx-bw/2,cy-bh/2,cx+bw/2,cy+bh/2),radius=12,fill=wood)
                d.rounded_rectangle((cx-bw/2+10,cy-bh/2+10,cx+bw/2-10,cy+bh/2-10),radius=10,fill=(220,211,198))
            elif "مطبخ" in name or i%5==2:
                d.rounded_rectangle((x1+22,y1+22,x2-22,y1+70),radius=6,fill=wood)
                d.rounded_rectangle((x2-70,y1+22,x2-22,y2-22),radius=6,fill=wood)
            else:
                sw=min(290,rw*.58)
                d.rounded_rectangle((cx-sw/2,cy-38,cx+sw/2,cy+38),radius=15,fill=(154,143,130))
                d.rounded_rectangle((cx-46,cy+58,cx+46,cy+108),radius=8,fill=(116,84,60))

    glow=Image.new("RGBA",(size,size),(0,0,0,0)); gd=ImageDraw.Draw(glow)
    gd.ellipse((-350,-260,size*.75,size*.72),fill=(255,230,185,46))
    glow=glow.filter(ImageFilter.GaussianBlur(150))
    img=Image.alpha_composite(img,glow)
    img=ImageEnhance.Contrast(img.convert("RGB")).enhance(1.05)
    img=ImageEnhance.Sharpness(img).enhance(1.1)
    out=io.BytesIO(); img.save(out,format="PNG",optimize=True); return out.getvalue()

def window(draw,x1,y1,x2,y2,stone,glass):
    draw.rectangle((x1-9,y1-9,x2+9,y2+9),fill=stone)
    draw.rectangle((x1,y1,x2,y2),fill=glass)
    draw.polygon([(x1+6,y1+5),(x2-6,y1+5),(x2-25,y2-5),(x1+22,y2-5)],fill=(110,145,160))
    mx=(x1+x2)/2; my=(y1+y2)/2
    draw.line((mx,y1,mx,y2),fill=(38,44,47),width=5); draw.line((x1,my,x2,my),fill=(38,44,47),width=5)

def render_exterior(payload: dict[str,Any], width: int=1536, height: int=2048) -> bytes:
    wall,stone,wood,glass,accent=style(str(payload.get("style") or "سعودي حديث"))
    floors=max(1,min(3,int(payload.get("floors") or 1)))
    garden=bool(payload.get("garden",True)); parking=bool(payload.get("parking",True)); fence=bool(payload.get("fence",True))
    formal=str(payload.get("entrance") or "formal")=="formal"
    minx,miny,maxx,maxy=bounds(payload.get("walls") or [])
    aspect=max(.8,min(2.1,(maxx-minx)/max(maxy-miny,1)))

    img=gradient((width,height),(113,177,225),(225,224,209)).convert("RGBA"); d=ImageDraw.Draw(img)
    horizon=int(height*.54)
    rnd=random.Random(17)
    for _ in range(7):
        bw=rnd.randint(110,230); bh=rnd.randint(100,210); bx=rnd.randint(-40,width-40)
        d.rectangle((bx,horizon-bh,bx+bw,horizon),fill=(213,207,194))
    d.rectangle((0,horizon,width,height),fill=(187,176,154))

    front_w=int(width*min(.70,.54+.08*(aspect-1))); fx=int(width*.12); depth=int(width*.15)
    base=int(height*.69); floor_h=int(height*.155); top=base-floors*floor_h
    poly=[(fx,top),(fx+front_w,top),(fx+front_w+depth,top+int(depth*.23)),(fx+front_w+depth,base+int(depth*.23)),(fx,base)]

    sh=Image.new("RGBA",(width,height),(0,0,0,0)); sd=ImageDraw.Draw(sh)
    sd.polygon([(x+22,y+28) for x,y in poly],fill=(0,0,0,72)); sh=sh.filter(ImageFilter.GaussianBlur(28))
    img=Image.alpha_composite(img,sh); d=ImageDraw.Draw(img)

    d.rectangle((fx,top,fx+front_w,base),fill=wall)
    d.polygon([(fx+front_w,top),(fx+front_w+depth,top+int(depth*.23)),(fx+front_w+depth,base+int(depth*.23)),(fx+front_w,base)],fill=mix(wall,(95,88,78),.14))
    tw=int(front_w*.23); d.rectangle((fx,top+8,fx+tw,base),fill=stone)
    for yy in range(top+18,base,30): d.line((fx,yy,fx+tw,yy),fill=mix(stone,(100,82,65),.13),width=2)

    cx=fx+int(front_w*.57); pw=int(front_w*(.18 if formal else .14)); ptop=top+int(floor_h*.22)
    d.rectangle((cx-pw//2,ptop,cx+pw//2,base),fill=mix(wall,(255,255,255),.12))
    d.rectangle((cx-pw//2-11,ptop-12,cx+pw//2+11,ptop),fill=mix(stone,(245,235,220),.18))
    d.rectangle((fx-8,top-24,fx+front_w+10,top+7),fill=mix(stone,(240,231,216),.28))

    for f in range(floors):
        fy=base-(f+1)*floor_h; y1=fy+int(floor_h*.25); y2=y1+int(floor_h*.48)
        for j,p in enumerate((.08,.30,.70,.84)):
            wx=fx+int(front_w*p); ww=int(front_w*(.115 if j in (0,3) else .095))
            if cx-pw//2-24<wx<cx+pw//2+24: continue
            window(d,wx,y1,wx+ww,y2,mix(stone,(245,238,226),.16),glass)

    door_w=int(pw*.55); door_h=int(floor_h*.66); dx=cx-door_w//2; dy=base-door_h
    d.rectangle((dx-16,dy-20,dx+door_w+16,base),fill=mix(stone,(235,223,204),.2))
    d.rounded_rectangle((dx,dy,dx+door_w,base),radius=8,fill=wood)
    for yy in range(dy+18,base-8,26): d.line((dx+12,yy,dx+door_w-12,yy),fill=(126,91,64),width=3)

    lawn_top=base+72
    d.rectangle((0,lawn_top,width,height),fill=(92,122,73) if garden else (176,165,145))
    d.polygon([(cx-170,base+84),(cx+170,base+84),(cx+335,height),(cx-335,height)],fill=(151,149,141))
    for i in range(5):
        yy=base+i*18; pad=10+i*22
        d.rectangle((cx-104-pad,yy,cx+104+pad,yy+18),fill=mix(stone,(175,160,140),.42))

    if parking:
        px=int(width*.79)
        d.polygon([(px-165,base+92),(px+100,base+92),(width,height),(px-300,height)],fill=(137,139,139))
        cy=int(height*.84)
        d.rounded_rectangle((px-105,cy-35,px+120,cy+70),radius=32,fill=(237,239,240),outline=(165,170,172),width=4)
        d.polygon([(px-65,cy-28),(px+70,cy-28),(px+92,cy+10),(px-84,cy+10)],fill=(75,99,111))

    if fence:
        fy=int(height*.82); d.rectangle((0,fy,width,fy+36),fill=mix(stone,(235,224,207),.22))
        for x in (40,fx-36,fx+front_w+depth+28,width-80): d.rectangle((x,fy-112,x+38,fy+50),fill=stone)
        gx1=cx-145; gx2=cx+145; d.rectangle((gx1,fy-80,gx2,fy+4),fill=(52,54,53))
        for x in range(gx1+12,gx2,24): d.line((x,fy-74,x,fy+1),fill=(115,112,104),width=4)

    if garden:
        for _ in range(46):
            x=rnd.randint(18,width-18); y=rnd.randint(lawn_top+28,height-20)
            if abs(x-cx)<340: continue
            r=rnd.randint(8,22); d.ellipse((x-r,y-r,x+r,y+r),fill=(55+rnd.randint(0,18),95+rnd.randint(0,28),47+rnd.randint(0,16)))
        for x in (95,width-120):
            ty=int(height*.66); d.rectangle((x-9,ty-145,x+9,ty+22),fill=(107,79,56))
            for a in range(0,360,36):
                ex=x+math.cos(math.radians(a))*85; ey=ty-145+math.sin(math.radians(a))*42
                d.line((x,ty-145,ex,ey),fill=(38,84,49),width=12)

    glow=Image.new("RGBA",(width,height),(0,0,0,0)); gd=ImageDraw.Draw(glow)
    for lx,ly in ((cx-pw//2-30,base-68),(cx+pw//2+30,base-68),(fx+front_w-85,base-60)):
        gd.ellipse((lx-52,ly-52,lx+52,ly+52),fill=(255,204,118,50))
    glow=glow.filter(ImageFilter.GaussianBlur(26)); img=Image.alpha_composite(img,glow)

    img=ImageEnhance.Contrast(img.convert("RGB")).enhance(1.08)
    img=ImageEnhance.Color(img).enhance(1.03)
    img=ImageEnhance.Sharpness(img).enhance(1.14)
    out=io.BytesIO(); img.save(out,format="PNG",optimize=True); return out.getvalue()
