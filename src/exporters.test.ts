import { describe, expect, it } from "vitest";
import { exportPlanDxf, exportQuantityCsv } from "./exporters";
import type { Wall } from "./types";

const wall: Wall = {
  id: "w1",
  a: { x: 0, y: 0 },
  b: { x: 400, y: 0 },
  thickness: 20,
};

describe("exports", () => {
  it("emits metric DXF layers", () => {
    const dxf = exportPlanDxf({
      walls: [wall],
      openings: [{
        id: "d1",
        wallId: "w1",
        kind: "door",
        centerT: 0.5,
        widthM: 1,
        heightM: 2.2,
        sillM: 0,
      }],
      columns: [],
      stairs: [],
      metersPerPixel: 0.01,
    });

    expect(dxf).toContain("$INSUNITS");
    expect(dxf).toContain("WALLS");
    expect(dxf).toContain("DOORS");
    expect(dxf.trim().endsWith("EOF")).toBe(true);
  });

  it("calculates quantity takeoff values", () => {
    const csv = exportQuantityCsv({
      walls: [wall],
      openings: [{
        id: "d1",
        wallId: "w1",
        kind: "door",
        centerT: 0.5,
        widthM: 1,
        heightM: 2,
        sillM: 0,
      }],
      columns: [],
      stairs: [],
      metersPerPixel: 0.01,
      wallHeightM: 3,
      roomAreaM2: 10,
    });

    expect(csv).toContain('"إجمالي أطوال الجدران","4.000","م"');
    expect(csv).toContain('"مساحة الجدران الإجمالية","12.000","م²"');
    expect(csv).toContain('"مساحة الفتحات","2.000","م²"');
    expect(csv).toContain('"مساحة الجدران الصافية","10.000","م²"');
  });
});
