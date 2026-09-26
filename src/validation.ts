import { dist } from "./geometry";
import type { Opening, Room, Wall } from "./types";

export type ValidationIssue = {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
};

export function validateReconstruction(
  walls: Wall[],
  openings: Opening[],
  rooms: Room[],
  metersPerPixel: number | null,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!metersPerPixel || metersPerPixel <= 0) {
    issues.push({ severity: "error", code: "scale-missing", message: "المقياس غير معاير؛ لا يمكن اعتبار الأبعاد دقيقة." });
  }

  if (walls.length < 4) {
    issues.push({ severity: "error", code: "walls-insufficient", message: "عدد الجدران غير كافٍ لبناء منزل مغلق." });
  }

  if (metersPerPixel && metersPerPixel > 0) {
    for (const wall of walls) {
      const lengthM = dist(wall.a, wall.b) * metersPerPixel;
      if (lengthM < 0.35) {
        issues.push({ severity: "warning", code: "wall-short", message: "يوجد جدار أقصر من 35 سم ويحتاج مراجعة." });
        break;
      }
    }
  }

  const openingsByWall = new Map<string, Opening[]>();
  for (const opening of openings) {
    const list = openingsByWall.get(opening.wallId) || [];
    list.push(opening);
    openingsByWall.set(opening.wallId, list);
    if (!walls.some((wall) => wall.id === opening.wallId)) {
      issues.push({ severity: "error", code: "orphan-opening", message: "توجد فتحة غير مرتبطة بجدار صالح." });
    }
  }

  for (const [wallId, list] of openingsByWall) {
    const wall = walls.find((item) => item.id === wallId);
    if (!wall || !metersPerPixel) continue;
    const wallLengthM = dist(wall.a, wall.b) * metersPerPixel;
    const ranges = list
      .map((opening) => {
        const center = opening.centerT * wallLengthM;
        return { start: center - opening.widthM / 2, end: center + opening.widthM / 2 };
      })
      .sort((a, b) => a.start - b.start);
    for (let i = 1; i < ranges.length; i++) {
      if (ranges[i].start < ranges[i - 1].end - 0.05) {
        issues.push({ severity: "warning", code: "openings-overlap", message: "يوجد تداخل بين فتحتين على نفس الجدار." });
        break;
      }
    }
  }

  if (walls.length >= 4 && rooms.length === 0) {
    issues.push({ severity: "warning", code: "rooms-none", message: "لم يتم اكتشاف مساحة مغلقة؛ راجع اتصال زوايا الجدران." });
  }

  const tinyRoom = rooms.find((room) => room.areaM2 < 1.2);
  if (tinyRoom) {
    issues.push({ severity: "warning", code: "room-tiny", message: "تم اكتشاف مساحة أصغر من 1.2 م²؛ قد تكون فجوة هندسية." });
  }

  if (!issues.some((issue) => issue.severity === "error") && rooms.length > 0) {
    issues.push({ severity: "info", code: "geometry-ready", message: "الهندسة الأساسية قابلة للمعاينة ثلاثية الأبعاد، مع بقاء المراجعة البشرية مطلوبة." });
  }

  return issues;
}
