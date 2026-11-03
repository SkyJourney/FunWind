import { describe, expect, it } from "vitest";
import { pickWinners, type CampaignRow } from "./service";

/**
 * 选优逻辑的纯函数测试：把 SQL 结果当作输入，不接库。
 * 时间窗过滤由 SQL 负责（集成测试覆盖），这里只验证「同 effect 冲突仲裁」与「坏行跳过」。
 */

function row(over: Partial<CampaignRow> & { id: number; effect: string }): CampaignRow {
  return {
    name: `方案 ${over.id}`,
    config: {},
    startsAt: "2026-01-01 00:00:00",
    endsAt: null,
    enabled: true,
    priority: 0,
    ...over,
  };
}

describe("同 effect 冲突选优", () => {
  it("单条命中直接生效", () => {
    const winners = pickWinners([row({ id: 1, effect: "theme.pack", config: { pack: "xmas" } })]);
    expect(winners.get("theme.pack")?.id).toBe(1);
  });

  it("priority 大者胜", () => {
    const winners = pickWinners([
      row({ id: 1, effect: "theme.pack", priority: 1, config: { pack: "aaa" } }),
      row({ id: 2, effect: "theme.pack", priority: 9, config: { pack: "bbb" } }),
    ]);
    expect(winners.get("theme.pack")?.id).toBe(2);
  });

  it("priority 相等时取后创建（id 更大）", () => {
    const winners = pickWinners([
      row({ id: 7, effect: "theme.pack", priority: 3, config: { pack: "aaa" } }),
      row({ id: 8, effect: "theme.pack", priority: 3, config: { pack: "bbb" } }),
    ]);
    expect(winners.get("theme.pack")?.id).toBe(8);
  });

  it("不同 effect 互不压制（换主题不影响换 LOGO）", () => {
    const winners = pickWinners([
      row({ id: 1, effect: "theme.pack", priority: 0, config: { pack: "xmas" } }),
      row({ id: 2, effect: "site.logo", priority: 0, config: { file: "logo-aaaa.png" } }),
      row({ id: 3, effect: "site.hero", priority: 0, config: { file: "hero-bbbb.png" } }),
    ]);
    expect([...winners.keys()].sort()).toEqual(["site.hero", "site.logo", "theme.pack"]);
    expect(winners.size).toBe(3);
  });

  it("未注册 effect 的行被跳过（不占用该 effect 名额）", () => {
    const winners = pickWinners([
      row({ id: 1, effect: "site.decor", config: { file: "decor-c.png" } }),
      row({ id: 2, effect: "theme.pack", config: { pack: "xmas" } }),
    ]);
    expect(winners.has("site.decor")).toBe(false);
    expect(winners.get("theme.pack")?.id).toBe(2);
  });

  it("配置不合法的行被跳过，不会顶掉合法行", () => {
    const winners = pickWinners([
      row({ id: 9, effect: "theme.pack", priority: 100, config: { pack: "BAD-ID" } }),
      row({ id: 2, effect: "theme.pack", priority: 0, config: { pack: "xmas" } }),
    ]);
    expect(winners.get("theme.pack")?.id).toBe(2);
  });

  it("全部行都不合法时返回空表（读取链据此走常态）", () => {
    const winners = pickWinners([
      row({ id: 1, effect: "theme.pack", config: { nope: true } }),
      row({ id: 2, effect: "unknown.effect", config: {} }),
    ]);
    expect(winners.size).toBe(0);
  });

  it("空输入返回空表", () => {
    expect(pickWinners([]).size).toBe(0);
  });
});
