import type { CalibrationEvidence, Point } from "./types";
import { dist } from "./geometry";

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function evidenceScale(evidence: CalibrationEvidence) {
  const px = dist(evidence.a, evidence.b);
  if (px <= 0 || evidence.meters <= 0) return null;
  return evidence.meters / px;
}

export function robustScale(evidence: CalibrationEvidence[]) {
  const scales = evidence.map(evidenceScale).filter((v): v is number => !!v && Number.isFinite(v));
  const m = median(scales);
  if (!m) return { metersPerPixel: null, spreadPct: null, count: 0 };

  const deviations = scales.map((v) => Math.abs(v - m) / m * 100);
  const spread = median(deviations) ?? 0;
  return {
    metersPerPixel: m,
    spreadPct: spread,
    count: scales.length,
  };
}

export function createEvidence(a: Point, b: Point, meters: number): CalibrationEvidence {
  return {
    id: Math.random().toString(36).slice(2, 10),
    a,
    b,
    meters,
  };
}
