from __future__ import annotations

import io
import math
import random
from typing import Any

from PIL import Image, ImageDraw, ImageFilter


STYLE = {
    "سعودي حديث": {
        "wall": (229, 222, 209),
        "stone": (190, 165, 132),
        "wood": (92, 64, 45),
        "glass": (84, 123, 139),
        "floor": (221, 211, 195),
        "accent": (63, 57, 50),
    },
    "نجدي حديث": {
        "wall": (205, 177, 143),
        "stone": (162, 122, 83),
        "wood": (85, 57, 39),
        "glass": (75, 111, 124),
        "floor": (206, 186, 159),
        "accent": (86, 60, 41),
    },
    "حجازي حديث": {
        "wall": (236, 222, 198),
        "stone": (191, 150, 106),
        "wood": (92, 57, 39),
        "glass": (58, 109, 130),
        "floor": (227, 207, 178),
        "accent": (47, 83, 99),
    },
    "مودرن فاخر": {
        "wall": (224, 223, 219),
        "stone": (170, 166, 158),
        "wood": (78, 66, 56),
        "glass": (57, 80, 91),
        "floor": (215, 211, 205),
        "accent": (44, 44, 44),
    },
}


def _palette(name: str):
    return STYLE.get(name, STYLE["سعودي حديث"])


def _soft_noise(img: Image.Image, amount: int = 7) -> Image.Image:
    px = img.load()
    rnd = random.Random(41)
    for _ in range(img.width * img.height // 65):
        x = rnd.randrange(img.width)
        y = rnd.randrange(img.height)
        r, g, b = px[x, y][:3]
        n = rnd.randint(-amount, amount)
        px[x, y] = (max(0, min(255, r+n)), max(0, min(255, g+n)), max(0, min(255, b+n)))
    return img


def _wall_bounds(walls: list[dict[str, Any]]):
    xs, ys = [], []
    for w in walls:
        for k in ("a", "b"):
            xs.append(float(w[k]["x"]))
            ys.append(float(w[k]["y"]))
    if not xs:
        return 0, 0, 1, 1
    return min(xs), min(ys), max(xs), max(ys)


def _map_point(x, y, bounds, canvas, pad=150):
    min_x, min_y, max_x, max_y = bounds
    w, h = canvas
    sx = (w - pad * 2) / max(max_x - min_x, 1)
    sy = (h - pad * 2) / max(max_y - min_y, 1)
    s = min(sx, sy)
    ox = (w - (max_x - min_x) * s) / 2 - min_x * s
    oy = (h - (max_y - min_y) * s) / 2 - min_y * s
    return x * s + ox, y * s + oy, s


def _draw_bed(draw, box, wood, fabric):
    x1, y1, x2, y2 = box
    draw.rounded_rectangle(box, radius=12, fill=wood)
    inset = 10
    draw.rounded_rectangle((x1+inset, y1+inset, x2-inset, y2-inset), radius=10, fill=fabric)
    pw = (x2-x1-inset*3)/2
    draw.rounded_rectangle((x1+inset, y1+inset, x1+inset+pw, y1+42), radius=8, fill=(242,238,231))
    draw.rounded_rectangle((x1+inset*2+pw, y1+inset, x2-inset, y1+42), radius=8, fill=(242,238,231))


def _draw_sofa(draw, box, color):
    x1,y1,x2,y2=box
    draw.rounded_rectangle(box, radius=14, fill=color)
    draw.rounded_rectangle((x1+10,y1+10,x2-10,y2-18), radius=12, fill=tuple(min(255,c+18) for c in color))
    draw.line((x1+10,(y1+y2)/2,x2-10,(y1+y2)/2), fill=(115,105,95), width=3)


def render_interior(payload: dict[str, Any], size: int = 2048) -> bytes:
    pal = _palette(str(payload.get("style") or "سعودي حديث"))
    walls = payload.get("walls") or []
    openings = payload.get("openings") or []
    rooms = payload.get("rooms") or []
    furnishing = str(payload.get("furnishing") or "full")
    bounds = _wall_bounds(walls)

    img = Image.new("RGB", (size, size), (239, 236, 230))
    bg = Image.new("RGB", (size, size), pal["floor"])
    bg = _soft_noise(bg, 5)
    img.paste(bg)
    draw = ImageDraw.Draw(img)

    # Sunlit border and plan drop shadow.
    mapped = []
    for w in walls:
        ax, ay, s = _map_point(float(w["a"]["x"]), float(w["a"]["y"]), bounds, (size,size))
        bx, by, _ = _map_point(float(w["b"]["x"]), float(w["b"]["y"]), bounds, (size,size))
        mapped.append((w, ax, ay, bx, by, s))

    shadow = Image.new("RGBA",(size,size),(0,0,0,0))
    sd = ImageDraw.Draw(shadow)
    for w,ax,ay,bx,by,s in mapped:
        thickness=max(18,min(46,float(w.get("thickness") or 12)*s*0.9))
        sd.line((ax+16,ay+20,bx+16,by+20), fill=(0,0,0,70), width=int(thickness+8))
    shadow=shadow.filter(ImageFilter.GaussianBlur(16))
    img=Image.alpha_composite(img.convert("RGBA"),shadow)
    draw=ImageDraw.Draw(img)

    # Room floor patches with subtle material alternation.
    for idx, room in enumerate(rooms):
        cells=room.get("cells") or []
        if not cells: continue
        col = pal["floor"]
        if idx % 3 == 1: col=tuple(max(0,c-8) for c in col)
        if idx % 3 == 2: col=tuple(min(255,c+7) for c in col)
        for cell in cells:
            x1,y1,_=_map_point(float(cell["x1"]),float(cell["y1"]),bounds,(size,size))
            x2,y2,_=_map_point(float(cell["x2"]),float(cell["y2"]),bounds,(size,size))
            draw.rectangle((x1,y1,x2,y2),fill=col)

    # Walls.
    for w,ax,ay,bx,by,s in mapped:
        thickness=max(18,min(48,float(w.get("thickness") or 12)*s*0.9))
        draw.line((ax,ay,bx,by),fill=(164,151,135),width=int(thickness+5))
        draw.line((ax,ay,bx,by),fill=pal["wall"],width=int(thickness))

    # Windows/doors on top of walls.
    by_id={str(w.get("id")):w for w in walls}
    for op in openings:
        w=by_id.get(str(op.get("wallId")))
        if not w: continue
        t=float(op.get("centerT",0.5))
        ax,ay,s=_map_point(float(w["a"]["x"]),float(w["a"]["y"]),bounds,(size,size))
        bx,by,_=_map_point(float(w["b"]["x"]),float(w["b"]["y"]),bounds,(size,size))
        cx=ax+(bx-ax)*t; cy=ay+(by-ay)*t
        dx=bx-ax; dy=by-ay; L=max(math.hypot(dx,dy),1)
        ux,uy=dx/L,dy/L
        half=max(16,float(op.get("widthM",1.0))*65)/2
        p1=(cx-ux*half,cy-uy*half); p2=(cx+ux*half,cy+uy*half)
        if op.get("kind")=="window":
            draw.line((*p1,*p2),fill=pal["glass"],width=14)
            draw.line((*p1,*p2),fill=(226,239,244),width=4)
        else:
            draw.line((*p1,*p2),fill=pal["wood"],width=16)

    # Automatic furniture from room extents.
    if furnishing != "none":
        for i, room in enumerate(rooms[:16]):
            cells=room.get("cells") or []
            if not cells: continue
            minx=min(float(c["x1"]) for c in cells); maxx=max(float(c["x2"]) for c in cells)
            miny=min(float(c["y1"]) for c in cells); maxy=max(float(c["y2"]) for c in cells)
            x1,y1,_=_map_point(minx,miny,bounds,(size,size))
            x2,y2,_=_map_point(maxx,maxy,bounds,(size,size))
            rw,rh=x2-x1,y2-y1
            if rw<100 or rh<100: continue
            cx,cy=(x1+x2)/2,(y1+y2)/2
            name=str(room.get("name") or "")
            density = 1 if furnishing=="light" else 2

            if "نوم" in name or "bed" in name.lower() or (i % 5 in (0,1) and rw>210 and rh>190):
                bw=min(rw*0.46,220); bh=min(rh*0.58,270)
                _draw_bed(draw,(cx-bw/2,cy-bh/2,cx+bw/2,cy+bh/2),pal["wood"],(215,202,185))
                if density>1:
                    draw.ellipse((x1+25,y1+25,x1+65,y1+65),fill=(87,117,75))
            elif "مطبخ" in name or "kitchen" in name.lower() or (i % 5==2 and rw>210):
                depth=42
                draw.rounded_rectangle((x1+22,y1+22,x2-22,y1+22+depth),radius=6,fill=pal["wood"])
                draw.rounded_rectangle((x2-22-depth,y1+22,x2-22,y2-22),radius=6,fill=pal["wood"])
                if density>1:
                    draw.ellipse((cx-22,cy-22,cx+22,cy+22),fill=(198,198,192))
            elif rw>250 and rh>190:
                sw=min(rw*0.62,300); sh=72
                _draw_sofa(draw,(cx-sw/2,cy-sh/2,cx+sw/2,cy+sh/2),(158,146,132))
                draw.rounded_rectangle((cx-45,cy+55,cx+45,cy+110),radius=8,fill=(123,89,61))
                if density>1:
                    draw.ellipse((x2-72,y1+28,x2-30,y1+70),fill=(78,116,71))

    # Warm light vignette.
    glow=Image.new("RGBA",(size,size),(0,0,0,0))
    gd=ImageDraw.Draw(glow)
    gd.ellipse((-350,-250,size*0.72,size*0.72),fill=(255,234,195,62))
    gd.ellipse((size*0.42,size*0.30,size+300,size+300),fill=(255,224,180,35))
    glow=glow.filter(ImageFilter.GaussianBlur(150))
    img=Image.alpha_composite(img,glow)

    # Gentle contrast vignette.
    vign=Image.new("L",(size,size),0)
    vd=ImageDraw.Draw(vign)
    vd.ellipse((-200,-200,size+200,size+200),fill=235)
    vign=vign.filter(ImageFilter.GaussianBlur(120))
    dark=Image.new("RGBA",(size,size),(15,12,10,30))
    dark.putalpha(Image.eval(vign,lambda p:255-p))
    img=Image.alpha_composite(img,dark)

    out=io.BytesIO()
    img.convert("RGB").save(out,format="PNG",optimize=True)
    return out.getvalue()


def render_exterior(payload: dict[str, Any], width: int = 2048, height: int = 1536) -> bytes:
    pal=_palette(str(payload.get("style") or "سعودي حديث"))
    floors=max(1,min(4,int(payload.get("floors") or 1)))
    garden=bool(payload.get("garden",True))
    parking=bool(payload.get("parking",True))
    fence=bool(payload.get("fence",True))
    entrance=str(payload.get("entrance") or "formal")

    img=Image.new("RGB",(width,height),(165,202,230))
    draw=ImageDraw.Draw(img)

    # Sky gradient.
    for y in range(height):
        t=y/height
        c=(int(151+55*t),int(195+42*t),int(229+18*t))
        draw.line((0,y,width,y),fill=c)

    horizon=int(height*0.63)
    draw.rectangle((0,horizon,width,height),fill=(184,171,146))
    if garden:
        draw.rectangle((0,horizon+90,width,height),fill=(116,137,91))

    house_x1=int(width*0.17); house_x2=int(width*0.83)
    base_y=int(height*0.77)
    floor_h=int(height*0.205)
    total_h=floors*floor_h
    top=base_y-total_h

    # Shadow.
    sh=Image.new("RGBA",(width,height),(0,0,0,0))
    sd=ImageDraw.Draw(sh)
    sd.rounded_rectangle((house_x1+35,top+45,house_x2+55,base_y+40),radius=16,fill=(0,0,0,75))
    sh=sh.filter(ImageFilter.GaussianBlur(32))
    img=Image.alpha_composite(img.convert("RGBA"),sh)
    draw=ImageDraw.Draw(img)

    # Main facade masses.
    draw.rectangle((house_x1,top,house_x2,base_y),fill=pal["wall"])
    wing_w=int((house_x2-house_x1)*0.25)
    draw.rectangle((house_x1,top+12,house_x1+wing_w,base_y),fill=pal["stone"])

    # Central projecting entrance volume.
    cx=(house_x1+house_x2)//2
    portal_w=int((house_x2-house_x1)*0.17)
    portal_top=top+int(floor_h*0.32)
    draw.rectangle((cx-portal_w//2,portal_top,cx+portal_w//2,base_y),fill=tuple(min(255,c+12) for c in pal["wall"]))
    draw.rectangle((cx-portal_w//2-12,portal_top-12,cx+portal_w//2+12,portal_top),fill=pal["stone"])

    # Cornice.
    draw.rectangle((house_x1-10,top-18,house_x2+10,top+10),fill=tuple(max(0,c-18) for c in pal["stone"]))
    draw.rectangle((house_x1-4,top-34,house_x2+4,top-18),fill=tuple(min(255,c+8) for c in pal["stone"]))

    # Windows per floor.
    facade_w=house_x2-house_x1
    for f in range(floors):
        fy=base_y-(f+1)*floor_h
        win_h=int(floor_h*0.52)
        win_y1=fy+int(floor_h*0.25); win_y2=win_y1+win_h
        positions=[
            house_x1+int(facade_w*0.10),
            house_x1+int(facade_w*0.31),
            house_x1+int(facade_w*0.67),
            house_x1+int(facade_w*0.82),
        ]
        for idx,x in enumerate(positions):
            if abs(x-cx)<portal_w: continue
            ww=int(facade_w*(0.11 if idx in (0,3) else 0.09))
            frame=(x,win_y1,x+ww,win_y2)
            draw.rectangle((frame[0]-10,frame[1]-10,frame[2]+10,frame[3]+10),fill=pal["stone"])
            draw.rectangle(frame,fill=pal["glass"])
            draw.line(((x+ww/2,win_y1),(x+ww/2,win_y2)),fill=(34,39,41),width=6)
            draw.line(((x,win_y1+win_h*0.52),(x+ww,win_y1+win_h*0.52)),fill=(34,39,41),width=6)

    # Main door.
    door_w=int(portal_w*0.48)
    door_h=int(floor_h*0.66)
    dx1=cx-door_w//2; dy1=base_y-door_h
    draw.rectangle((dx1-16,dy1-18,dx1+door_w+16,base_y),fill=pal["stone"])
    draw.rounded_rectangle((dx1,dy1,dx1+door_w,base_y),radius=8,fill=pal["wood"])
    for yy in range(dy1+22,base_y-10,28):
        draw.line((dx1+12,yy,dx1+door_w-12,yy),fill=(122,91,67),width=3)

    # Front steps and path.
    for i in range(4):
        y=base_y+i*18
        pad=i*22
        draw.rectangle((cx-115-pad,y,cx+115+pad,y+18),fill=(196-i*4,181-i*4,158-i*4))
    draw.polygon([(cx-185,base_y+72),(cx+185,base_y+72),(cx+300,height),(cx-300,height)],fill=(151,146,135))

    # Fence and gate.
    if fence:
        fy=int(height*0.83)
        draw.rectangle((0,fy,width,fy+42),fill=pal["stone"])
        post_w=42
        for x in (45,house_x1-40,house_x2+40,width-85):
            draw.rectangle((x,fy-120,x+post_w,fy+58),fill=pal["stone"])
        gate_x1=cx-150; gate_x2=cx+150
        draw.rectangle((gate_x1,fy-86,gate_x2,fy+10),fill=(54,58,57))
        for x in range(gate_x1+15,gate_x2,26):
            draw.line((x,fy-78,x,fy+4),fill=(112,110,103),width=4)

    # Parking pad and simple car silhouette.
    if parking:
        px=int(width*0.72)
        draw.polygon([(px-170,base_y+95),(px+160,base_y+95),(px+330,height),(px-300,height)],fill=(145,144,139))
        cy=int(height*0.87)
        draw.rounded_rectangle((px-110,cy-45,px+145,cy+60),radius=35,fill=(236,238,238))
        draw.rectangle((px-60,cy-38,px+100,cy+5),fill=(75,96,106))
        draw.ellipse((px-95,cy+38,px-45,cy+88),fill=(38,38,38))
        draw.ellipse((px+85,cy+38,px+135,cy+88),fill=(38,38,38))

    if garden:
        rnd=random.Random(12)
        for _ in range(26):
            x=rnd.randint(15,width-15); y=rnd.randint(int(height*0.80),height-15)
            if abs(x-cx)<320: continue
            r=rnd.randint(14,32)
            draw.ellipse((x-r,y-r,x+r,y+r),fill=(61+rnd.randint(0,25),105+rnd.randint(0,30),54))
        # palms
        for x in (100,width-120):
            trunk_y=int(height*0.72)
            draw.rectangle((x-10,trunk_y-150,x+10,trunk_y+20),fill=(111,82,57))
            for ang in range(0,360,45):
                ex=x+math.cos(math.radians(ang))*85
                ey=trunk_y-150+math.sin(math.radians(ang))*42
                draw.line((x,trunk_y-150,ex,ey),fill=(43,94,53),width=16)

    # Architectural warm lighting.
    glow=Image.new("RGBA",(width,height),(0,0,0,0))
    gd=ImageDraw.Draw(glow)
    for gx in (house_x1+120,cx,house_x2-120):
        gy=base_y-90
        gd.ellipse((gx-70,gy-70,gx+70,gy+70),fill=(255,211,135,42))
    glow=glow.filter(ImageFilter.GaussianBlur(45))
    img=Image.alpha_composite(img,glow)

    # Texture and camera-like vignette.
    rgb=_soft_noise(img.convert("RGB"),4)
    img=rgb.convert("RGBA")
    vign=Image.new("L",(width,height),0)
    vd=ImageDraw.Draw(vign)
    vd.ellipse((-250,-180,width+250,height+180),fill=242)
    vign=vign.filter(ImageFilter.GaussianBlur(180))
    overlay=Image.new("RGBA",(width,height),(0,0,0,40))
    overlay.putalpha(Image.eval(vign,lambda p:255-p))
    img=Image.alpha_composite(img,overlay)

    out=io.BytesIO()
    img.convert("RGB").save(out,format="PNG",optimize=True)
    return out.getvalue()
