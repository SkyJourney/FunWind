import { describe, expect, it } from "vitest";
import { evaluateGate } from "./evaluate";
import type { GateFacts, GateMeta } from "./types";

const gate = (over: Partial<GateMeta> = {}): GateMeta => ({
  id: 1,
  postId: 10,
  gateKey: "a1",
  conditions: [{ type: "points", price: 50 }],
  matchMode: "all",
  unlockCount: 0,
  ...over,
});
const facts = (over: Partial<GateFacts> = {}): GateFacts => ({
  viewerId: 7,
  isAuthor: false,
  isModerator: false,
  unlocked: new Map(),
  hasReplied: false,
  balance: 80,
  ...over,
});
const unlockedAt = (id = 1) =>
  new Map([[id, { unlockedAt: "2026-10-13 09:00:00", pricePaid: 50 }]]);

describe("evaluateGate · 永远可见的人", () => {
  it("作者本人：开放（即使没登录事实以外的任何条件）", () => {
    expect(evaluateGate(gate(), facts({ isAuthor: true }))).toEqual({
      open: true,
      reason: "author",
    });
  });

  it("版主 / admin：开放", () => {
    expect(evaluateGate(gate(), facts({ isModerator: true }))).toEqual({
      open: true,
      reason: "moderator",
    });
  });

  it("作者优先于版主标签", () => {
    expect(evaluateGate(gate(), facts({ isAuthor: true, isModerator: true }))).toMatchObject({
      reason: "author",
    });
  });
});

describe("evaluateGate · 未登录", () => {
  it("游客对任何类型的门控都只得到登录提示（包括价格 0 与回复可见）", () => {
    for (const conditions of [
      [{ type: "points", price: 50 }],
      [{ type: "points", price: 0 }],
      [{ type: "reply" }],
      [{ type: "mystery" }],
    ]) {
      expect(evaluateGate(gate({ conditions }), facts({ viewerId: null }))).toEqual({
        open: false,
        prompts: [{ kind: "login" }],
      });
    }
  });
});

describe("evaluateGate · points", () => {
  it("未解锁：锁定，提示价格与余额", () => {
    expect(evaluateGate(gate(), facts())).toEqual({
      open: false,
      prompts: [{ kind: "points", price: 50, balance: 80 }],
    });
  });

  it("已解锁：开放，带购买记录（用于「已购买」标签）", () => {
    expect(evaluateGate(gate(), facts({ unlocked: unlockedAt() }))).toEqual({
      open: true,
      reason: "unlocked",
      pricePaid: 50,
      unlockedAt: "2026-10-13 09:00:00",
    });
  });

  it("解锁记录按门控 id 区分：解锁了别的门控不算数", () => {
    expect(evaluateGate(gate(), facts({ unlocked: unlockedAt(999) })).open).toBe(false);
  });

  it("价格 0：同样需要解锁记录（登录后点击解锁），不是自动放行", () => {
    const g = gate({ conditions: [{ type: "points", price: 0 }] });
    expect(evaluateGate(g, facts())).toEqual({
      open: false,
      prompts: [{ kind: "points", price: 0, balance: 80 }],
    });
    expect(evaluateGate(g, facts({ unlocked: unlockedAt() })).open).toBe(true);
  });

  it("价格缺失/负数/小数/字符串：失败即封闭，视为不可用而不是免费", () => {
    for (const price of [undefined, -1, 1.5, "50", null, Number.NaN]) {
      expect(evaluateGate(gate({ conditions: [{ type: "points", price }] }), facts())).toEqual({
        open: false,
        prompts: [{ kind: "unavailable" }],
      });
    }
  });
});

describe("evaluateGate · reply", () => {
  const g = gate({ conditions: [{ type: "reply" }] });

  it("未回复：锁定；已回复：开放", () => {
    expect(evaluateGate(g, facts())).toEqual({ open: false, prompts: [{ kind: "reply" }] });
    expect(evaluateGate(g, facts({ hasReplied: true }))).toMatchObject({
      open: true,
      reason: "replied",
    });
  });
});

describe("evaluateGate · 组合与封闭", () => {
  const both = [{ type: "points", price: 5 }, { type: "reply" }];

  it("all：必须全部满足；提示只列未满足的", () => {
    const g = gate({ conditions: both, matchMode: "all" });
    expect(evaluateGate(g, facts({ hasReplied: true }))).toEqual({
      open: false,
      prompts: [{ kind: "points", price: 5, balance: 80 }],
    });
    expect(evaluateGate(g, facts({ unlocked: unlockedAt() }))).toEqual({
      open: false,
      prompts: [{ kind: "reply" }],
    });
    expect(evaluateGate(g, facts({ hasReplied: true, unlocked: unlockedAt() })).open).toBe(true);
  });

  it("any：满足其一即开放，优先展示购买记录", () => {
    const g = gate({ conditions: both, matchMode: "any" });
    expect(evaluateGate(g, facts()).open).toBe(false);
    expect(evaluateGate(g, facts({ hasReplied: true }))).toMatchObject({
      open: true,
      reason: "replied",
    });
    expect(evaluateGate(g, facts({ hasReplied: true, unlocked: unlockedAt() }))).toMatchObject({
      open: true,
      reason: "unlocked",
      pricePaid: 50,
    });
  });

  it("未知条件类型：失败即封闭（all 下整体锁定；any 下不影响其他条件）", () => {
    const g = gate({ conditions: [{ type: "mystery" }] });
    expect(evaluateGate(g, facts())).toEqual({ open: false, prompts: [{ kind: "unavailable" }] });
    const mixAll = gate({ conditions: [{ type: "mystery" }, { type: "reply" }], matchMode: "all" });
    expect(evaluateGate(mixAll, facts({ hasReplied: true })).open).toBe(false);
    const mixAny = gate({ conditions: [{ type: "mystery" }, { type: "reply" }], matchMode: "any" });
    expect(evaluateGate(mixAny, facts({ hasReplied: true })).open).toBe(true);
  });

  it("没有任何条件的脏数据：封闭，不是放行", () => {
    expect(evaluateGate(gate({ conditions: [] }), facts())).toEqual({
      open: false,
      prompts: [{ kind: "unavailable" }],
    });
  });

  it("作者与版主仍然能看未知类型/脏数据的门控（便于排查）", () => {
    expect(evaluateGate(gate({ conditions: [] }), facts({ isAuthor: true })).open).toBe(true);
    expect(
      evaluateGate(gate({ conditions: [{ type: "x" }] }), facts({ isModerator: true })).open,
    ).toBe(true);
  });
});
