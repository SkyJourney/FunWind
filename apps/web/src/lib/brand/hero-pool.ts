import { createBrandPool, type BrandItem, type BrandPool } from "./brand-pool";

/**
 * 首页 Hero 横幅池（M11 插槽 ⑤，docs/THEME-SYSTEM.md §3）：brand-pool 的 hero 实例——
 * 复刻 LOGO 池模式：PNG 直存 STORAGE_DIR/site/、/brand/hero 公开输出、site_settings("site.hero")；
 * 前台首页无当前项则不占位（零数据部署友好）。写路径仅 Hero 管理页（site.admin 门禁）。
 */

export type HeroItem = BrandItem;
export type HeroPool = BrandPool;

export const heroPool = createBrandPool({
  key: "site.hero",
  prefix: "hero",
  targetType: "hero",
  actionPrefix: "admin.hero",
});

export const parseHeroPool = heroPool.parse;
export const getHeroPoolRaw = heroPool.getRaw;
export const setActiveHero = heroPool.setActive;
export const removeHero = heroPool.remove;
