import { describe, expect, it } from "vitest";
import { demoBusinessCounts, demoCheckin } from "./index";

describe("demo-checkin 消费业务事件（M6.5c）", () => {
  it("收到 thread.created / thread.replied / attachment.uploaded 即计数；未订阅的事件不计", () => {
    const before = demoBusinessCounts();
    // 消费方只需要「到达」这一信号，不读取载荷
    const h = demoCheckin.events! as Record<string, () => void>;
    h["thread.created"]!();
    h["thread.replied"]!();
    h["attachment.uploaded"]!();
    const after = demoBusinessCounts();
    expect((after["thread.created"] ?? 0) - (before["thread.created"] ?? 0)).toBe(1);
    expect((after["thread.replied"] ?? 0) - (before["thread.replied"] ?? 0)).toBe(1);
    expect((after["attachment.uploaded"] ?? 0) - (before["attachment.uploaded"] ?? 0)).toBe(1);
  });
});
