import { describe, expect, it } from "vitest";
import { campaignStatus, overriddenBy, type CampaignWindow } from "./status";

const NOW = "2026-12-24 12:00:00";

function win(over: Partial<CampaignWindow> & { id: number }): CampaignWindow {
  return {
    effect: "theme.pack",
    enabled: true,
    startsAt: "2026-12-01 00:00:00",
    endsAt: "2027-01-01 00:00:00",
    priority: 0,
    ...over,
  };
}

describe("方案状态", () => {
  it("窗口内 → active；未开始 → upcoming；已结束 → ended", () => {
    expect(campaignStatus(win({ id: 1 }), NOW)).toBe("active");
    expect(campaignStatus(win({ id: 1, startsAt: "2026-12-25 00:00:00" }), NOW)).toBe("upcoming");
    expect(campaignStatus(win({ id: 1, endsAt: "2026-12-20 00:00:00" }), NOW)).toBe("ended");
  });

  it("起点恰为当前 → 已生效；终点恰为当前 → 已结束（左闭右开）", () => {
    expect(campaignStatus(win({ id: 1, startsAt: NOW }), NOW)).toBe("active");
    expect(campaignStatus(win({ id: 1, endsAt: NOW }), NOW)).toBe("ended");
  });

  it("结束时间为空 = 长期有效", () => {
    expect(campaignStatus(win({ id: 1, endsAt: null }), NOW)).toBe("active");
  });

  it("停用优先于时间判断", () => {
    expect(campaignStatus(win({ id: 1, enabled: false }), NOW)).toBe("disabled");
    expect(campaignStatus(win({ id: 1, enabled: false, endsAt: "2026-01-01 00:00:00" }), NOW)).toBe(
      "disabled",
    );
  });
});

describe("同 effect 重叠压制", () => {
  it("高优先级压制低优先级，反之不成立", () => {
    const map = overriddenBy([win({ id: 1, priority: 1 }), win({ id: 2, priority: 5 })], NOW);
    expect(map.get(1)).toBe(2);
    expect(map.has(2)).toBe(false);
  });

  it("优先级相等取 id 大者", () => {
    const map = overriddenBy([win({ id: 7 }), win({ id: 8 })], NOW);
    expect(map.get(7)).toBe(8);
    expect(map.has(8)).toBe(false);
  });

  it("三方重叠时记录压制它的最高优先级方案", () => {
    const map = overriddenBy(
      [win({ id: 1, priority: 1 }), win({ id: 2, priority: 3 }), win({ id: 3, priority: 9 })],
      NOW,
    );
    expect(map.get(1)).toBe(3);
    expect(map.get(2)).toBe(3);
  });

  it("首尾相接不算重叠", () => {
    const a = win({ id: 1, startsAt: "2026-12-01 00:00:00", endsAt: "2026-12-25 00:00:00" });
    const b = win({ id: 2, priority: 9, startsAt: "2026-12-25 00:00:00", endsAt: null });
    expect(overriddenBy([a, b], NOW).size).toBe(0);
  });

  it("不同 effect 互不压制", () => {
    const map = overriddenBy(
      [win({ id: 1 }), win({ id: 2, effect: "site.logo", priority: 9 })],
      NOW,
    );
    expect(map.size).toBe(0);
  });

  it("已结束与已停用的方案既不压制别人，也不被提示", () => {
    const ended = win({ id: 9, priority: 99, endsAt: "2026-12-20 00:00:00" });
    const off = win({ id: 8, priority: 98, enabled: false });
    expect(overriddenBy([win({ id: 1 }), ended, off], NOW).size).toBe(0);
  });

  it("未来的窗口与当前窗口相交时同样提示", () => {
    const now = win({ id: 1, endsAt: null });
    const future = win({ id: 2, priority: 5, startsAt: "2027-02-01 00:00:00", endsAt: null });
    expect(overriddenBy([now, future], NOW).get(1)).toBe(2);
  });
});
