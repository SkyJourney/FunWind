/**
 * 内置主题包值升级表与种子的一致性（M11.6 Step 6）。纯逻辑，不连库。
 * 升级表登记「旧值 → 新值」，种子写「当前值」，两处各抄一遍，手抄错一处就会让存量库升到错的值，
 * 全新建库却没事，线上线下表现不一致且很难发现，所以在这里逐条核对。
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
  it("表不是空的，key 唯一", () => {
    expect(THEME_PACK_VALUE_UPGRADES.length).toBeGreaterThan(0);
    const keys = THEME_PACK_VALUE_UPGRADES.map((upgrade) => upgrade.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(THEME_PACK_VALUE_UPGRADES.map((upgrade) => [upgrade.key, upgrade] as const))(
    "%s：包是内置种子，每条路径的新值等于种子当前值，旧值不等于新值，路径不重复",
    (_key, upgrade) => {
      const seed = seedOf(upgrade.packId);
      expect(seed, `种子里没有 ${upgrade.packId}`).toBeDefined();
      expect(upgrade.swaps.length).toBeGreaterThan(0);
      const seen = new Set<string>();
      for (const swap of upgrade.swaps) {
        const label = swap.path.join(".");
        expect(valueAt(seed!.definition, swap.path), `${label}：种子当前值`).toBe(swap.to);
        expect(swap.from, `${label}：旧值与新值相同，升级是空操作`).not.toBe(swap.to);
        expect(seen.has(label), `${label} 重复登记`).toBe(false);
        seen.add(label);
      }
    },
  );

  it("qy2010 的升级覆盖种子里全部用到品牌色与次要文字色的位置：种子里不应再出现任何登记过的旧值", () => {
    const seed = seedOf("qy2010")!;
    const olds = THEME_PACK_VALUE_UPGRADES.filter((upgrade) => upgrade.packId === "qy2010")
      .flatMap((upgrade) => upgrade.swaps)
      .map((swap) => String(swap.from).toLowerCase());
    expect(olds.length).toBeGreaterThan(0);
    const text = JSON.stringify(seed.definition).toLowerCase();
    for (const old of new Set(olds)) {
      expect(text.includes(old), `种子里还残留旧值 ${old}，没有登记到升级表或没改完`).toBe(false);
    }
  });

  it("内置主题色表里 qy2010 的 themeColor 与种子 pwa 一致（目录对缺 pwa 的行的兜底）", () => {
    const seed = seedOf("qy2010")!;
    expect(BUILTIN_THEME_COLORS.qy2010).toEqual(seed.definition.pwa);
  });
});
