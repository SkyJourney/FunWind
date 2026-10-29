import { describe, expect, it } from "vitest";
import { fmtDate, fmtDateTime } from "./format";

/**
 * 后台时间格式化（M9.5）：DB「YYYY-MM-DD HH:mm:ss」→ zh-CN Intl 口径；null/undefined → 占位符。
 */
describe("lib/admin/format", () => {
  it("fmtDateTime：DB 字符串按本地时区解析为 zh-CN 短日期时间", () => {
    // 北京墙面时间字符串 → "2026/5/1 10:00" 形态（Intl 输出不含秒）
    const out = fmtDateTime("2026-05-01 10:00:00");
    expect(out).toMatch(/^2026\/5\/1/);
    expect(out).toContain("10:00");
  });

  it("fmtDateTime：空值 → —", () => {
    expect(fmtDateTime(null)).toBe("—");
    expect(fmtDateTime(undefined)).toBe("—");
    expect(fmtDateTime("")).toBe("—");
  });

  it("fmtDate：只取日期部分", () => {
    expect(fmtDate("2026-05-01 10:00:00")).toBe("2026/5/1");
    expect(fmtDate(null)).toBe("—");
  });
});
