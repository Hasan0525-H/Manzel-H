import { describe, expect, it } from "vitest";
import { isBrowserImagePlan } from "./cloudBuilder";

describe("isBrowserImagePlan", () => {
  it("recognizes Android JPG files even when MIME type is missing", () => {
    expect(isBrowserImagePlan({ name: "IMG-20260910-WA0004.jpg", type: "" })).toBe(true);
  });

  it("recognizes Android JPG files with generic MIME metadata", () => {
    expect(isBrowserImagePlan({
      name: "IMG-20260910-WA0004.jpg",
      type: "application/octet-stream",
    })).toBe(true);
  });

  it("keeps PDFs on the queued conversion path", () => {
    expect(isBrowserImagePlan({ name: "plan.pdf", type: "application/pdf" })).toBe(false);
  });
});
