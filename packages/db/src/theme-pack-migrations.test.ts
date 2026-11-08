/**
 * 内置主题包值升级表与种子的一致性（M11.6 Step 6）。纯逻辑，不连库。
 * 升级表登记「旧值 → 新值」，种子写「当前值」，两处各抄一遍，手抄错一处就会让存量库升到错的值，
 * 全新建库却没事，线上线下表现不一致且很难发现，所以在这里逐条核对。
 *
 * 站长决策（2026-11-08）：qy2010 不再内置（站点自定义主题），其升级条目已执行完毕并移除，
 * 登记表当前为空——保留「空表也校验」的哨兵，将来 default 或新内置包登记升级时自动接管。
 */
import { describe, expect, it } from "vitest";
import { THEME_PACK_VALUE_UPGRADES } from "./theme-pack-migrations.js";
import { BUILTIN_THEME_COLORS, BUILTIN_THEME_PACK_SEEDS } from "./theme-pack-seeds.js";

/** 按路径取值；任何一段缺失返回 undefined */
function valueAt(root: unknown, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

const seedOf = (id: string) => BUILTIN_THEME_PACK_SEEDS.find((seed) => seed.id === id);

describe("THEME_PACK_VALUE_UPGRADES 与种子", () => {
  it("key 唯一，且每条的包都是内置种子", () => {
    const keys = THEME_PACK_VALUE_UPGRADES.map((upgrade) => upgrade.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const upgrade of THEME_PACK_VALUE_UPGRADES) {
      expect(seedOf(upgrade.packId), `种子里没有 ${upgrade.packId}`).toBeDefined();
    }
  });

  it.each(THEME_PACK_VALUE_UPGRADES.map((upgrade) => [upgrade.key, upgrade] as const))(
    "%s：每条路径的新值等于种子当前值，旧值不等于新值，路径不重复",
    (_key, upgrade) => {
      const seed = seedOf(upgrade.packId)!;
      expect(upgrade.swaps.length).toBeGreaterThan(0);
      const seen = new Set<string>();
      for (const swap of upgrade.swaps) {
        const label = swap.path.join(".");
        expect(valueAt(seed.definition, swap.path), `${label}：种子当前值`).toBe(swap.to);
        expect(swap.from, `${label}：旧值与新值相同，升级是空操作`).not.toBe(swap.to);
        expect(seen.has(label), `${label} 重复登记`).toBe(false);
        seen.add(label);
      }
    },
  );

  it("qy2010 不再是内置种子（站长 2026-11-08 拍板），但其已知 PWA 色值仍登记在主题色表", () => {
    expect(seedOf("qy2010")).toBeUndefined();
    expect(BUILTIN_THEME_COLORS.qy2010).toEqual({
      themeColor: "#116a92",
      backgroundColor: "#f6f3e7",
    });
  });
});
