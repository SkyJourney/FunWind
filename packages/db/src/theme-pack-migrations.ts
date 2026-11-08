import type { PathSwap } from "./theme-pack-upgrade.js";

/**
 * 内置主题包的值升级表（M11.6 Step 6）。
 *
 * 种子只按主键补缺，已存在的内置行不会因为种子里的值改了而变化。需要「把存量库里的某个旧值换成新值」
 * 时（品牌色加深这类有意的外观变化），把路径与新旧值登记在这里，bootstrap 经 swapManyIfUnchanged 执行：
 * 路径上的值仍等于旧值才替换，站长改过的不覆盖；全新建库直接取种子里的新值，这张表对它们是空操作。
 *
 * 约定：
 *  · 每个包一组，一次升级一条 UPDATE，revision 只 +1；
 *  · `from` 必须是历史上种子真正写过的值，`to` 必须等于当前种子里同一路径的值
 *    （theme-pack-migrations.test 逐条核对，登记表与种子对不上会变红）；
 *  · 登记项只增不改：已发布的升级不要回头改它的 from/to，需要再变就追加新一组，旧库按顺序逐组升级。
 *
 * 站长决策（2026-11-08）：qy2010 不再内置（站点自定义主题），其历史升级条目（qy2010-brand-and-muted-aa，
 * 已在全部存量库执行完毕）随之移除——升级原语保留，供将来 default 或新内置包使用。
 */

/** 单次升级：包 id + 一批路径替换 */
export interface ThemePackValueUpgrade {
  /** 升级编号，仅用于日志与测试定位，不写库 */
  key: string;
  packId: string;
  swaps: readonly PathSwap[];
}

export const THEME_PACK_VALUE_UPGRADES: readonly ThemePackValueUpgrade[] = [];
