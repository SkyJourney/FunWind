import { describe, expect, it, vi } from "vitest";
import { isFutureBeijingDateTime, nowBeijingWallTime, parseDbDateTime } from "./datetime";

describe("parseDbDateTime", () => {
  it("空格分隔的墙面时间按 +08:00 解析", () => {
    const d = parseDbDateTime("2026-10-23 09:00:00");
    expect(d.getTime()).toBe(Date.UTC(2026, 9, 23, 1, 0, 0)); // 09:00+08:00 → 01:00Z
  });

  it("ISO T 分隔同样处理", () => {
    expect(parseDbDateTime("2026-10-23T09:00:00").getTime()).toBe(Date.UTC(2026, 9, 23, 1, 0, 0));
  });

  it("已带时区的字符串不重复加偏移", () => {
    expect(parseDbDateTime("2026-10-23T01:00:00Z").getTime()).toBe(Date.UTC(2026, 9, 23, 1, 0, 0));
    expect(parseDbDateTime("2026-10-23T09:00:00+08:00").getTime()).toBe(
      Date.UTC(2026, 9, 23, 1, 0, 0),
    );
  });

  it("解析结果与进程时区无关（UTC 容器一致性）", () => {
    // 同一字符串在任何时区下解析出的 UTC 时刻一致
    const a = parseDbDateTime("2026-01-01 00:30:00");
    expect(a.toISOString()).toBe("2025-12-31T16:30:00.000Z");
  });
});

describe("isFutureBeijingDateTime", () => {
  const now = Date.UTC(2026, 9, 31, 1, 0, 0);

  it.each([
    "",
    "2099-1-01 00:00:00",
    "2099-01-01T00:00:00",
    "2099-01-01 00:00",
    "2099-01-01 00:00:00.001",
    "2099-01-01 00:00:00+08:00",
    " 2099-01-01 00:00:00 ",
    "2099-00-01 00:00:00",
    "2099-13-01 00:00:00",
    "2099-01-00 00:00:00",
    "2099-04-31 00:00:00",
    "2099-02-29 00:00:00",
    "2096-02-30 00:00:00",
    "2100-02-29 00:00:00",
    "2099-01-01 24:00:00",
    "2099-01-01 00:60:00",
    "2099-01-01 00:00:60",
    "0000-01-01 00:00:00",
    "0099-01-01 00:00:00",
  ])("格式或日历回读不一致时拒绝 %s", (value) => {
    expect(isFutureBeijingDateTime(value, now)).toBe(false);
  });

  it.each(["2028-02-29 00:00:00", "2000-02-29 00:00:00", "2400-02-29 23:59:59"])(
    "四年与世纪闰年 %s 按精确日历回读通过",
    (value) => {
      expect(isFutureBeijingDateTime(value, Date.UTC(1999, 0, 1))).toBe(true);
    },
  );

  it("未来为严格大于：同秒、前一秒与毫秒边界不放宽", () => {
    const value = "2026-10-31 09:00:00";
    expect(isFutureBeijingDateTime(value, now - 1)).toBe(true);
    expect(isFutureBeijingDateTime(value, now)).toBe(false);
    expect(isFutureBeijingDateTime(value, now + 1)).toBe(false);
    expect(isFutureBeijingDateTime("2026-10-31 09:00:01", now + 999)).toBe(true);
    expect(isFutureBeijingDateTime("2026-10-31 08:59:59", now)).toBe(false);
  });

  it("缺省时使用当前时刻，北京跨年墙面值不受进程时区影响", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 11, 31, 16, 0, 0));
    try {
      expect(isFutureBeijingDateTime("2027-01-01 00:00:00")).toBe(false);
      expect(isFutureBeijingDateTime("2027-01-01 00:00:01")).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });
});

describe("nowBeijingWallTime", () => {
  it("输出 YYYY-MM-DD HH:MM:SS 形态", () => {
    expect(nowBeijingWallTime()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});
