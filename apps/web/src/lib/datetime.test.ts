import { describe, expect, it } from "vitest";
import { nowBeijingWallTime, parseDbDateTime } from "./datetime";

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

describe("nowBeijingWallTime", () => {
  it("输出 YYYY-MM-DD HH:MM:SS 形态", () => {
    expect(nowBeijingWallTime()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});
