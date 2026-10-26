import { describe, expect, it } from "vitest";
import { channelLabel, POINT_CHANNEL_LABELS } from "./labels";

describe("渠道显示名（labels）", () => {
  it("已知渠道映射；未知渠道原样返回", () => {
    expect(channelLabel("earn.post")).toBe("发帖奖励");
    expect(channelLabel("spend.gate_unlock")).toBe("解锁内容");
    expect(channelLabel("opening")).toBe("期初余额");
    expect(channelLabel("earn.unknown_future")).toBe("earn.unknown_future");
  });

  it("渠道表键数固定（新增渠道须同步）", () => {
    expect(Object.keys(POINT_CHANNEL_LABELS)).toHaveLength(7);
  });
});
