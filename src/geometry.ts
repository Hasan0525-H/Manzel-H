import type { Opening, Point, Reconstruction, Rect, Room, Wall } from "./types";

export function dist(a: Point, b: Point) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function snapPoint(p: Point, step = 5): Point {
  return {
    x: Math.round(p.x / step) * step,
    y: Math.round(p.y / step) * step,
  };
}

export function projectToSegment(p: Point, a: Point, b: Point) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2));
  const q = { x: a.x + vx * t, y: a.y + vy * t };
  return { t, q, distance: dist(p, q) };
}

export function pointOnWall(wall: Wall, t: number): Point {
  return {
    x: wall.a.x + (wall.b.x - wall.a.x) * t,
    y: wall.a.y + (wall.b.y - wall.a.y) * t,
  };
}

function isHorizontal(w: Wall) {
  return Math.abs(w.a.y - w.b.y) <= Math.abs(w.a.x - w.b.x);
}

function overlap(a1: number, a2: number, b1: number, b2: number) {
  const lo = Math.max(Math.min(a1, a2), Math.min(b1, b2));
  const hi = Math.min(Math.max(a1, a2), Math.max(b1, b2));
  return Math.max(0, hi - lo);
}

function cluster(values: number[], tolerance: number) {
  if (!values.length) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const groups: number[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const current = groups[groups.length - 1];
    const mean = current.reduce((s, v) => s + v, 0) / current.length;
    if (Math.abs(sorted[i] - mean) <= tolerance) current.push(sorted[i]);
    else groups.push([sorted[i]]);
  }
  return groups.map((g) => g.reduce((s, v) => s + v, 0) / g.length);
}

function pointInRect(p: Point, r: Rect) {
  return p.x > r.x1 && p.x < r.x2 && p.y > r.y1 && p.y < r.y2;
}

function pointInRooms(p: Point, rooms: Room[]) {
  return rooms.some((room) => room.cells.some((cell) => pointInRect(p, cell)));
}

export function detectRooms(
  walls: Wall[],
  metersPerPixel: number | null,
  previousNames: Record<string, string> = {},
): Reconstruction {
  if (!walls.length || !metersPerPixel || metersPerPixel <= 0) {
    return { rooms: [], exteriorWallIds: [] };
  }

  const axisWalls = walls.filter(
    (w) => Math.abs(w.a.x - w.b.x) < 18 || Math.abs(w.a.y - w.b.y) < 18,
  );
  if (axisWalls.length < 4) return { rooms: [], exteriorWallIds: [] };

  const allX = axisWalls.flatMap((w) => [w.a.x, w.b.x]);
  const allY = axisWalls.flatMap((w) => [w.a.y, w.b.y]);
  const minX = Math.min(...allX);
  const maxX = Math.max(...allX);
  const minY = Math.min(...allY);
  const maxY = Math.max(...allY);
  const span = Math.max(maxX - minX, maxY - minY, 100);
  const tolerance = Math.max(6, Math.min(14, span * 0.008));
  const margin = Math.max(28, span * 0.045);

  const xs = cluster([...allX, minX - margin, maxX + margin], tolerance).sort((a, b) => a - b);
  const ys = cluster([...allY, minY - margin, maxY + margin], tolerance).sort((a, b) => a - b);

  if (xs.length < 3 || ys.length < 3 || xs.length * ys.length > 10000) {
    return { rooms: [], exteriorWallIds: [] };
  }

  const vertical = axisWalls.filter((w) => !isHorizontal(w));
  const horizontal = axisWalls.filter(isHorizontal);

  const blocksVertical = (x: number, y1: number, y2: number) => {
    const len = Math.max(1, y2 - y1);
    let covered = 0;
    for (const wall of vertical) {
      const wx = (wall.a.x + wall.b.x) / 2;
      if (Math.abs(wx - x) > tolerance) continue;
      covered += overlap(wall.a.y, wall.b.y, y1, y2);
    }
    return covered >= Math.max(len * 0.62, Math.min(18, len));
  };

  const blocksHorizontal = (y: number, x1: number, x2: number) => {
    const len = Math.max(1, x2 - x1);
    let covered = 0;
    for (const wall of horizontal) {
      const wy = (wall.a.y + wall.b.y) / 2;
      if (Math.abs(wy - y) > tolerance) continue;
      covered += overlap(wall.a.x, wall.b.x, x1, x2);
    }
    return covered >= Math.max(len * 0.62, Math.min(18, len));
  };

  const cols = xs.length - 1;
  const rows = ys.length - 1;
  const idOf = (c: number, r: number) => r * cols + c;
  const crOf = (id: number) => ({ c: id % cols, r: Math.floor(id / cols) });

  const neighbors = (c: number, r: number) => {
    const out: number[] = [];
    const x1 = xs[c], x2 = xs[c + 1], y1 = ys[r], y2 = ys[r + 1];

    if (c > 0 && !blocksVertical(x1, y1, y2)) out.push(idOf(c - 1, r));
    if (c < cols - 1 && !blocksVertical(x2, y1, y2)) out.push(idOf(c + 1, r));
    if (r > 0 && !blocksHorizontal(y1, x1, x2)) out.push(idOf(c, r - 1));
    if (r < rows - 1 && !blocksHorizontal(y2, x1, x2)) out.push(idOf(c, r + 1));
    return out;
  };

  const exterior = new Set<number>();
  const queue: number[] = [];
  for (let c = 0; c < cols; c++) {
    queue.push(idOf(c, 0), idOf(c, rows - 1));
  }
  for (let r = 0; r < rows; r++) {
    queue.push(idOf(0, r), idOf(cols - 1, r));
  }

  while (queue.length) {
    const id = queue.shift()!;
    if (exterior.has(id)) continue;
    exterior.add(id);
    const { c, r } = crOf(id);
    for (const n of neighbors(c, r)) if (!exterior.has(n)) queue.push(n);
  }

  const interiors = new Set<number>();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const id = idOf(c, r);
      if (!exterior.has(id)) interiors.add(id);
    }
  }

  const rooms: Room[] = [];
  let roomIndex = 1;
  while (interiors.size) {
    const seed = interiors.values().next().value as number;
    const component: number[] = [];
    const stack = [seed];
    interiors.delete(seed);

    while (stack.length) {
      const id = stack.pop()!;
      component.push(id);
      const { c, r } = crOf(id);
      for (const n of neighbors(c, r)) {
        if (interiors.has(n)) {
          interiors.delete(n);
          stack.push(n);
        }
      }
    }

    const cells: Rect[] = component.map((id) => {
      const { c, r } = crOf(id);
      return { x1: xs[c], y1: ys[r], x2: xs[c + 1], y2: ys[r + 1] };
    });
    const areaPx2 = cells.reduce((sum, cell) => sum + (cell.x2 - cell.x1) * (cell.y2 - cell.y1), 0);
    const areaM2 = areaPx2 * metersPerPixel * metersPerPixel;
    if (areaM2 < 0.65) continue;

    let cx = 0;
    let cy = 0;
    for (const cell of cells) {
      const a = (cell.x2 - cell.x1) * (cell.y2 - cell.y1);
      cx += ((cell.x1 + cell.x2) / 2) * a;
      cy += ((cell.y1 + cell.y2) / 2) * a;
    }
    const centroid = { x: cx / areaPx2, y: cy / areaPx2 };
    const stableKey = `${Math.round(centroid.x / 10)}:${Math.round(centroid.y / 10)}`;
    rooms.push({
      id: `room-${roomIndex++}`,
      cells,
      areaM2,
      centroid,
      name: previousNames[stableKey] || `غرفة ${rooms.length + 1}`,
    });
  }

  rooms.sort((a, b) => b.areaM2 - a.areaM2);
  rooms.forEach((room, i) => {
    if (/^غرفة \d+$/.test(room.name)) room.name = `مساحة ${i + 1}`;
  });

  const exteriorWallIds: string[] = [];
  const sampleOffset = Math.max(10, tolerance * 1.5);
  for (const wall of axisWalls) {
    const mx = (wall.a.x + wall.b.x) / 2;
    const my = (wall.a.y + wall.b.y) / 2;
    const dx = wall.b.x - wall.a.x;
    const dy = wall.b.y - wall.a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const p1 = { x: mx + nx * sampleOffset, y: my + ny * sampleOffset };
    const p2 = { x: mx - nx * sampleOffset, y: my - ny * sampleOffset };
    const aInside = pointInRooms(p1, rooms);
    const bInside = pointInRooms(p2, rooms);
    if (aInside !== bInside) exteriorWallIds.push(wall.id);
  }

  return { rooms, exteriorWallIds };
}

export function updateRoomNames(
  rooms: Room[],
  names: Record<string, string>,
): Room[] {
  return rooms.map((room) => {
    const key = `${Math.round(room.centroid.x / 10)}:${Math.round(room.centroid.y / 10)}`;
    return { ...room, name: names[key] || room.name };
  });
}

export function openingIntervalMeters(opening: Opening, wallLengthM: number) {
  const center = opening.centerT * wallLengthM;
  return {
    start: Math.max(0, center - opening.widthM / 2),
    end: Math.min(wallLengthM, center + opening.widthM / 2),
  };
}


export function canonicalizeAndInferOpenings(
  walls: Wall[],
  metersPerPixel: number | null,
): { walls: Wall[]; openings: Opening[] } {
  if (!metersPerPixel || metersPerPixel <= 0 || walls.length < 2) {
    return { walls, openings: [] };
  }

  const tolerance = Math.max(8, 0.16 / metersPerPixel);
  const minOpeningPx = 0.62 / metersPerPixel;
  const maxOpeningPx = 2.2 / metersPerPixel;

  type Segment = {
    wall: Wall;
    horizontal: boolean;
    fixed: number;
    start: number;
    end: number;
  };

  const segments: Segment[] = walls
    .filter((w) => Math.abs(w.a.x - w.b.x) < tolerance || Math.abs(w.a.y - w.b.y) < tolerance)
    .map((wall) => {
      const horizontal = Math.abs(wall.a.y - wall.b.y) <= Math.abs(wall.a.x - wall.b.x);
      return {
        wall,
        horizontal,
        fixed: horizontal ? (wall.a.y + wall.b.y) / 2 : (wall.a.x + wall.b.x) / 2,
        start: horizontal ? Math.min(wall.a.x, wall.b.x) : Math.min(wall.a.y, wall.b.y),
        end: horizontal ? Math.max(wall.a.x, wall.b.x) : Math.max(wall.a.y, wall.b.y),
      };
    });

  const unused = new Set(segments.map((_, i) => i));
  const canonical: Wall[] = [];
  const inferred: Opening[] = [];

  while (unused.size) {
    const seedIndex = unused.values().next().value as number;
    const seed = segments[seedIndex];
    const groupIndexes = [...unused].filter((i) => {
      const s = segments[i];
      return s.horizontal === seed.horizontal && Math.abs(s.fixed - seed.fixed) <= tolerance;
    });
    groupIndexes.forEach((i) => unused.delete(i));

    const group = groupIndexes.map((i) => segments[i]).sort((a, b) => a.start - b.start);
    let clusterStart = group[0].start;
    let clusterEnd = group[0].end;
    let fixedWeighted = group[0].fixed * (group[0].end - group[0].start);
    let fixedWeight = group[0].end - group[0].start;
    let thicknessSum = group[0].wall.thickness;
    let thicknessCount = 1;
    let gaps: Array<{ start: number; end: number }> = [];

    const flush = () => {
      const fixed = fixedWeight > 0 ? fixedWeighted / fixedWeight : seed.fixed;
      const id = `wall-${Math.random().toString(36).slice(2, 10)}`;
      const wall: Wall = seed.horizontal
        ? {
            id,
            a: { x: clusterStart, y: fixed },
            b: { x: clusterEnd, y: fixed },
            thickness: thicknessSum / thicknessCount,
          }
        : {
            id,
            a: { x: fixed, y: clusterStart },
            b: { x: fixed, y: clusterEnd },
            thickness: thicknessSum / thicknessCount,
          };
      canonical.push(wall);
      const total = Math.max(1, clusterEnd - clusterStart);
      for (const gap of gaps) {
        const widthPx = gap.end - gap.start;
        const widthM = widthPx * metersPerPixel;
        const center = (gap.start + gap.end) / 2;
        inferred.push({
          id: `opening-${Math.random().toString(36).slice(2, 10)}`,
          wallId: id,
          kind: widthM <= 1.18 ? "door" : "window",
          centerT: Math.max(0, Math.min(1, (center - clusterStart) / total)),
          widthM: Math.max(0.65, Math.min(2.1, widthM)),
          heightM: widthM <= 1.18 ? 2.2 : 1.35,
          sillM: widthM <= 1.18 ? 0 : 0.9,
        });
      }
    };

    for (let i = 1; i < group.length; i++) {
      const current = group[i];
      const gap = current.start - clusterEnd;
      if (gap <= maxOpeningPx) {
        if (gap >= minOpeningPx) gaps.push({ start: clusterEnd, end: current.start });
        clusterEnd = Math.max(clusterEnd, current.end);
        const weight = current.end - current.start;
        fixedWeighted += current.fixed * weight;
        fixedWeight += weight;
        thicknessSum += current.wall.thickness;
        thicknessCount++;
      } else {
        flush();
        clusterStart = current.start;
        clusterEnd = current.end;
        const weight = current.end - current.start;
        fixedWeighted = current.fixed * weight;
        fixedWeight = weight;
        thicknessSum = current.wall.thickness;
        thicknessCount = 1;
        gaps = [];
      }
    }
    flush();
  }

  return { walls: canonical, openings: inferred };
}


export function snapOrthogonalIntersections(
  walls: Wall[],
  metersPerPixel: number | null,
): Wall[] {
  if (!walls.length) return walls;
  const tolerance = metersPerPixel && metersPerPixel > 0
    ? Math.max(6, Math.min(24, 0.22 / metersPerPixel))
    : 14;

  const horizontal = walls.filter((w) => Math.abs(w.a.y - w.b.y) <= Math.abs(w.a.x - w.b.x));
  const vertical = walls.filter((w) => Math.abs(w.a.y - w.b.y) > Math.abs(w.a.x - w.b.x));
  const next = walls.map((w) => ({ ...w, a: { ...w.a }, b: { ...w.b } }));
  const byId = new Map(next.map((w) => [w.id, w]));

  for (const h of horizontal) {
    const targetH = byId.get(h.id)!;
    const hy = (h.a.y + h.b.y) / 2;
    let hx1 = Math.min(h.a.x, h.b.x);
    let hx2 = Math.max(h.a.x, h.b.x);

    for (const v of vertical) {
      const vx = (v.a.x + v.b.x) / 2;
      const vy1 = Math.min(v.a.y, v.b.y);
      const vy2 = Math.max(v.a.y, v.b.y);
      const horizontalNear = vx >= hx1 - tolerance && vx <= hx2 + tolerance;
      const verticalNear = hy >= vy1 - tolerance && hy <= vy2 + tolerance;
      if (!horizontalNear || !verticalNear) continue;

      const targetV = byId.get(v.id)!;
      const hLeftIsA = targetH.a.x <= targetH.b.x;
      const vTopIsA = targetV.a.y <= targetV.b.y;

      if (Math.abs(vx - hx1) <= tolerance) {
        if (hLeftIsA) targetH.a.x = vx;
        else targetH.b.x = vx;
        hx1 = vx;
      }
      if (Math.abs(vx - hx2) <= tolerance) {
        if (hLeftIsA) targetH.b.x = vx;
        else targetH.a.x = vx;
        hx2 = vx;
      }
      if (Math.abs(hy - vy1) <= tolerance) {
        if (vTopIsA) targetV.a.y = hy;
        else targetV.b.y = hy;
      }
      if (Math.abs(hy - vy2) <= tolerance) {
        if (vTopIsA) targetV.b.y = hy;
        else targetV.a.y = hy;
      }

      targetH.a.y = hy;
      targetH.b.y = hy;
      targetV.a.x = vx;
      targetV.b.x = vx;
    }
  }

  return next;
}
