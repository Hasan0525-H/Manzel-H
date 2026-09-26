import { describe, expect, it } from "vitest";
import { canonicalizeAndInferOpenings, dist, projectToSegment, snapPoint } from "./geometry";
import type { Wall } from "./types";

describe("geometry primitives", () => {
  it("computes distances and snaps points", () => {
    expect(dist({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(snapPoint({ x: 12, y: 18 }, 5)).toEqual({ x: 10, y: 20 });
  });

  it("projects points onto wall segments", () => {
    const projected = projectToSegment({ x: 5, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 });
    expect(projected.t).toBeCloseTo(0.5);
    expect(projected.q).toEqual({ x: 5, y: 0 });
    expect(projected.distance).toBeCloseTo(4);
  });

  it("merges collinear wall runs and infers a door-sized gap", () => {
    const walls: Wall[] = [
      { id: "a", a: { x: 0, y: 0 }, b: { x: 200, y: 0 }, thickness: 10 },
      { id: "b", a: { x: 300, y: 0 }, b: { x: 600, y: 0 }, thickness: 10 },
    ];
    const result = canonicalizeAndInferOpenings(walls, 0.01);
    expect(result.walls).toHaveLength(1);
    expect(result.openings).toHaveLength(1);
    expect(result.openings[0].kind).toBe("door");
    expect(result.openings[0].widthM).toBeCloseTo(1);
  });
});
