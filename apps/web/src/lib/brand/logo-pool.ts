import { createBrandPool, type BrandItem, type BrandPool } from "./brand-pool";

/**
 * LOGO 池（M10.5，docs/LOGO-POOL.md）：brand-pool 的 logo 实例——
 * 品牌位全端公开（含游客/每页必出），独立写 STORAGE_DIR/site/ 并经 /brand/logo 公开路由输出；
 * 池元数据存 site_settings("site.logo")。写路径仅 LOGO 管理页（site.admin 门禁）
 * 与主题↔LOGO 联动（M11，docs/THEME-SYSTEM.md §5）。
 */

export type LogoItem = BrandItem;
export type LogoPool = BrandPool;

export const logoPool = createBrandPool({
  key: "site.logo",
  prefix: "logo",
  targetType: "logo",
  actionPrefix: "admin.logo",
});

export const parseLogoPool = logoPool.parse;
export const getLogoPoolRaw = logoPool.getRaw;
export const setActiveLogo = logoPool.setActive;
export const removeLogo = logoPool.remove;
export const registerLogo = logoPool.register;
