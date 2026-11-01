import { createBrandPool } from "./brand-pool";

/**
 * 主题装饰素材池（M11.1 Step 4，docs/milestones/M11.1-theme-engine.md Step 4）：
 * 主题包可引用的背景/底纹/装饰图素材（brand-pool 第三实例）。
 * 池元数据存 site_settings("site.decor")；文件直存 STORAGE_DIR/site/（不进 files 表——
 * 装饰素材是站点级公开资源，不走附件授权管线）。
 * 包引用只记 poolFile（M11.1 Step 5 编辑器写入约定），运行时经 /brand/decor 公开输出。
 */
export const decorPool = createBrandPool({
  key: "site.decor",
  prefix: "decor",
  targetType: "decor",
  actionPrefix: "admin.decor",
});

export const parseDecorPool = decorPool.parse;
export const getDecorPoolRaw = decorPool.getRaw;
export const setActiveDecor = decorPool.setActive;
export const removeDecor = decorPool.remove;
