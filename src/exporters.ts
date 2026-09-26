import type { Column, Opening, Stair, Wall } from "./types";
import { dist } from "./geometry";

type DxfEntity = string[];

const pair = (code: number, value: string | number) => [String(code), String(value)];

function lineEntity(layer: string, x1: number, y1: number, x2: number, y2: number): DxfEntity {
  return [
    ...pair(0, "LINE"),
    ...pair(8, layer),
    ...pair(10, x1.toFixed(6)),
    ...pair(20, y1.toFixed(6)),
    ...pair(30, 0),
    ...pair(11, x2.toFixed(6)),
    ...pair(21, y2.toFixed(6)),
    ...pair(31, 0),
  ];
}

function lwPolyline(layer: string, points: Array<[number, number]>, closed = true): DxfEntity {
  const out = [
    ...pair(0, "LWPOLYLINE"),
    ...pair(8, layer),
    ...pair(90, points.length),
    ...pair(70, closed ? 1 : 0),
  ];
  for (const [x, y] of points) {
    out.push(...pair(10, x.toFixed(6)), ...pair(20, y.toFixed(6)));
  }
  return out;
}

function wallOutline(wall: Wall, metersPerPixel: number): Array<[number, number]> {
  const ax = wall.a.x * metersPerPixel;
  const ay = -wall.a.y * metersPerPixel;
  const bx = wall.b.x * metersPerPixel;
  const by = -wall.b.y * metersPerPixel;
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const half = wall.thickness * metersPerPixel / 2;
  const nx = -dy / len * half;
  const ny = dx / len * half;
  return [
    [ax + nx, ay + ny],
    [bx + nx, by + ny],
    [bx - nx, by - ny],
    [ax - nx, ay - ny],
  ];
}

export function exportPlanDxf(args: {
  walls: Wall[];
  openings: Opening[];
  columns: Column[];
  stairs: Stair[];
  metersPerPixel: number;
}) {
  const { walls, openings, columns, stairs, metersPerPixel } = args;
  const entities: DxfEntity[] = [];

  for (const wall of walls) {
    entities.push(lwPolyline("WALLS", wallOutline(wall, metersPerPixel), true));
  }

  for (const opening of openings) {
    const wall = walls.find((w) => w.id === opening.wallId);
    if (!wall) continue;
    const wallLengthM = dist(wall.a, wall.b) * metersPerPixel;
    if (wallLengthM <= 0) continue;

    const ax = wall.a.x * metersPerPixel;
    const ay = -wall.a.y * metersPerPixel;
    const bx = wall.b.x * metersPerPixel;
    const by = -wall.b.y * metersPerPixel;
    const ux = (bx - ax) / wallLengthM;
    const uy = (by - ay) / wallLengthM;
    const center = opening.centerT * wallLengthM;
    const half = opening.widthM / 2;
    const x1 = ax + ux * Math.max(0, center - half);
    const y1 = ay + uy * Math.max(0, center - half);
    const x2 = ax + ux * Math.min(wallLengthM, center + half);
    const y2 = ay + uy * Math.min(wallLengthM, center + half);
    entities.push(lineEntity(opening.kind === "door" ? "DOORS" : "WINDOWS", x1, y1, x2, y2));
  }

  for (const column of columns) {
    const cx = column.point.x * metersPerPixel;
    const cy = -column.point.y * metersPerPixel;
    const hw = column.widthM / 2;
    const hd = column.depthM / 2;
    entities.push(lwPolyline("COLUMNS", [
      [cx - hw, cy - hd],
      [cx + hw, cy - hd],
      [cx + hw, cy + hd],
      [cx - hw, cy + hd],
    ], true));
  }

  for (const stair of stairs) {
    const cx = stair.origin.x * metersPerPixel;
    const cy = -stair.origin.y * metersPerPixel;
    const angle = stair.rotationDeg * Math.PI / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const transform = (lx: number, ly: number): [number, number] => [
      cx + lx * cos - ly * sin,
      cy + lx * sin + ly * cos,
    ];

    const hw = stair.widthM / 2;
    const hr = stair.runM / 2;
    entities.push(lwPolyline("STAIRS", [
      transform(-hw, -hr),
      transform(hw, -hr),
      transform(hw, hr),
      transform(-hw, hr),
    ], true));

    const steps = Math.max(2, Math.round(stair.steps));
    for (let i = 1; i < steps; i++) {
      const y = -hr + stair.runM * i / steps;
      const a = transform(-hw, y);
      const b = transform(hw, y);
      entities.push(lineEntity("STAIR_TREADS", a[0], a[1], b[0], b[1]));
    }
  }

  const body = entities.flat().join("\n");
  return [
    "0","SECTION","2","HEADER",
    "9","$INSUNITS","70","6",
    "0","ENDSEC",
    "0","SECTION","2","ENTITIES",
    body,
    "0","ENDSEC","0","EOF",
  ].join("\n");
}

export function downloadTextFile(content: string, filename: string, mime = "text/plain") {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
