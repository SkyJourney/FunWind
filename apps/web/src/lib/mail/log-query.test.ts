import { describe, expect, it } from "vitest";
import { parseEmailLogFilter } from "./log-query";

describe("parseEmailLogFilter", () => {
  it("合法枚举透传；非法值一律忽略", () => {
    expect(parseEmailLogFilter({ status: "failed", kind: "security" })).toEqual({
      status: "failed",
      kind: "security",
      page: 1,
    });
    expect(parseEmailLogFilter({ status: "ok", kind: "verify2", scene: "Inject!" })).toEqual({
      page: 1,
    });
  });

  it("scene 只收 a-z0-9- 语法（与模板 id 同域）；q 截断到 120", () => {
    expect(parseEmailLogFilter({ scene: "pm-received" }).scene).toBe("pm-received");
    expect(parseEmailLogFilter({ scene: "pm_received" }).scene).toBeUndefined();
    expect(parseEmailLogFilter({ q: "x".repeat(200) }).q).toHaveLength(120);
  });

  it("页码脏输入回 1", () => {
    expect(parseEmailLogFilter({ page: "3" }).page).toBe(3);
    expect(parseEmailLogFilter({ page: "abc" }).page).toBe(1);
    expect(parseEmailLogFilter({ page: "-2" }).page).toBe(1);
  });
});
