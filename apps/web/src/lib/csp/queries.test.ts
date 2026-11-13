import { describe, expect, it } from "vitest";
import { parseCspFilter } from "./queries";

describe("parseCspFilter（纯函数，非法值回退）", () => {
  it("directive/document 去空白并截断", () => {
    expect(parseCspFilter({ directive: "  script-src  " }).directive).toBe("script-src");
    expect(parseCspFilter({ directive: "a".repeat(100) }).directive).toHaveLength(64);
    expect(parseCspFilter({ document: " /admin/themes " }).document).toBe("/admin/themes");
    expect(parseCspFilter({ document: "a".repeat(300) }).document).toHaveLength(200);
  });

  it("空/纯空白忽略", () => {
    expect(parseCspFilter({ directive: "   ", document: "" })).toEqual({ page: 1 });
  });

  it("页码非正整数回退 1", () => {
    expect(parseCspFilter({ page: "2" }).page).toBe(2);
    for (const page of ["0", "-1", "x", "2.5", ""]) {
      expect(parseCspFilter({ page }).page).toBe(1);
    }
  });
});
