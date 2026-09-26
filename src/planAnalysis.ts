import { canonicalizeAndInferOpenings, snapOrthogonalIntersections } from "./geometry";
import type { Opening, Wall } from "./types";

const uid = () => Math.random().toString(36).slice(2, 10);

export async function analyzePlanLocally(
  imageUrl: string,
  metersPerPixel: number | null,
  wallThicknessM: number,
): Promise<{ walls: Wall[]; openings: Opening[] }> {
  const image = new Image();
  image.src = imageUrl;
  await image.decode();

  const maxWidth = 1000;
  const down = Math.min(1, maxWidth / image.naturalWidth);
  const width = Math.max(1, Math.round(image.naturalWidth * down));
  const height = Math.max(1, Math.round(image.naturalHeight * down));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return { walls: [], openings: [] };
  ctx.drawImage(image, 0, 0, width, height);
  const pixels = ctx.getImageData(0, 0, width, height).data;

  const wallPixel = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const dark = r + g + b < 230;
    const blue = b > 105 && b > r * 1.13 && b > g * 1.02;
    return dark || blue;
  };

  const rowScore = (y: number) => {
    let score = 0;
    for (let x = 0; x < width; x += 2) if (wallPixel(x, y)) score++;
    return score;
  };
  const colScore = (x: number) => {
    let score = 0;
    for (let y = 0; y < height; y += 2) if (wallPixel(x, y)) score++;
    return score;
  };

  const rows = Array.from({ length: height }, (_, y) => rowScore(y));
  const cols = Array.from({ length: width }, (_, x) => colScore(x));
  const rowThreshold = Math.max(8, Math.floor(width * 0.035));
  const colThreshold = Math.max(8, Math.floor(height * 0.035));

  const peaks = (scores: number[], threshold: number) => {
    const result: number[] = [];
    let start = -1;
    for (let i = 0; i <= scores.length; i++) {
      const active = i < scores.length && scores[i] >= threshold;
      if (active && start < 0) start = i;
      if ((!active || i === scores.length) && start >= 0) {
        const end = i - 1;
        let best = start;
        for (let j = start + 1; j <= end; j++) if (scores[j] > scores[best]) best = j;
        result.push(best);
        start = -1;
      }
    }
    return result;
  };

  const candidates: Wall[] = [];
  const k = 1 / down;
  const minRun = Math.max(35, Math.floor(Math.min(width, height) * 0.05));
  const thicknessPx = metersPerPixel ? Math.max(4, wallThicknessM / metersPerPixel) : 12;

  const collectRuns = (horizontal: boolean, fixedValues: number[]) => {
    for (const fixed of fixedValues) {
      const limit = horizontal ? width : height;
      let start = -1;
      let misses = 0;

      for (let variable = 0; variable <= limit; variable++) {
        const x = horizontal ? variable : fixed;
        const y = horizontal ? fixed : variable;
        const on = variable < limit && wallPixel(x, y);

        if (on) {
          if (start < 0) start = variable;
          misses = 0;
          continue;
        }

        if (start >= 0) {
          misses++;
          if (misses > 5 || variable === limit) {
            const end = variable - misses;
            if (end - start >= minRun) {
              candidates.push({
                id: uid(),
                a: horizontal ? { x: start * k, y: fixed * k } : { x: fixed * k, y: start * k },
                b: horizontal ? { x: end * k, y: fixed * k } : { x: fixed * k, y: end * k },
                thickness: thicknessPx,
              });
            }
            start = -1;
            misses = 0;
          }
        }
      }
    }
  };

  collectRuns(true, peaks(rows, rowThreshold));
  collectRuns(false, peaks(cols, colThreshold));

  const deduped: Wall[] = [];
  for (const wall of candidates) {
    const horizontal = Math.abs(wall.a.y - wall.b.y) <= Math.abs(wall.a.x - wall.b.x);
    const duplicate = deduped.some((other) => {
      const otherHorizontal = Math.abs(other.a.y - other.b.y) <= Math.abs(other.a.x - other.b.x);
      if (horizontal !== otherHorizontal) return false;
      if (horizontal) {
        const near = Math.abs(other.a.y - wall.a.y) < 15;
        const a1 = Math.min(other.a.x, other.b.x);
        const a2 = Math.max(other.a.x, other.b.x);
        const b1 = Math.min(wall.a.x, wall.b.x);
        const b2 = Math.max(wall.a.x, wall.b.x);
        return near && Math.max(a1, b1) <= Math.min(a2, b2) + 24;
      }
      const near = Math.abs(other.a.x - wall.a.x) < 15;
      const a1 = Math.min(other.a.y, other.b.y);
      const a2 = Math.max(other.a.y, other.b.y);
      const b1 = Math.min(wall.a.y, wall.b.y);
      const b2 = Math.max(wall.a.y, wall.b.y);
      return near && Math.max(a1, b1) <= Math.min(a2, b2) + 24;
    });
    if (!duplicate) deduped.push(wall);
    if (deduped.length >= 180) break;
  }

  const canonical = canonicalizeAndInferOpenings(deduped, metersPerPixel);
  return {
    walls: snapOrthogonalIntersections(canonical.walls, metersPerPixel),
    openings: canonical.openings,
  };
}
