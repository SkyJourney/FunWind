import { z } from "zod";

/**
 * 运营排期效果（effect）注册表（M11.2，docs/milestones/M11.2-theme-switching.md）。
 *
 * 一个 effect = 一种「被排期临时覆盖的站点生效值」。本期只注册视觉类三项
 * （主题包 / LOGO / Hero），后续邀请码策略、积分加成等**只加注册项**，不改表、不改读取骨架。
 *
 * 设计约束（来自全仓既有范式与一次失败教训）：
 *  · 未知 effect 键在**读、写两侧都拒绝**（fail-closed）——同 lib/points/channels 的「未注册即拒」。
 *    但这里是"读配置"方向，拒绝的形态是"该行不生效"，不是抛错：一条坏方案不该让整站白屏。
 *  · 注册表必须同时有消费者（apps/web/src/lib/chrome/site-chrome.ts 的合成），
 *    只加类型不加消费 = 名义可插拔（docs/GATES.md §M6.1 修订记录的反例）。
 *  · schema 一律 `.strict()`：多一个字段就拒绝，防止把拼写错误静默变成默认值。
 */

/** effect 配置的公共形态：纯数据，可 JSON 序列化，不含 URL / 路径 / CSS 文本 */
export interface CampaignEffect<C> {
  /** 注册键，落 campaigns.effect 列（varchar 32） */
  readonly key: string;
  /** 后台展示名 */
  readonly label: string;
  /** 配置里唯一的目标字段名：后台表单只提交这个值，由 configFromTarget 组装成完整配置 */
  readonly targetKey: "pack" | "file";
  /** 配置的严格校验；未知字段拒绝 */
  readonly schema: z.ZodType<C>;
  /** 后台卡片上的一行摘要（纯函数，不含 IO） */
  readonly describe: (config: C) => string;
}

/** 主题包 id 语法（与 lib/theme/packs.ts 的 THEME_PACK_ID_RE 同口径，避免循环依赖故本地重复） */
const PACK_ID_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
/** 素材池文件名：宽松口径（兼容历史短名），与 lib/brand/brand-pool.ts 的 safeNameOf 一致 */
const LOGO_FILE_RE = /^logo-[a-z0-9]+\.png$/;
const HERO_FILE_RE = /^hero-[a-z0-9]+\.png$/;

export const themePackEffect: CampaignEffect<{ pack: string }> = {
  key: "theme.pack",
  label: "主题包",
  targetKey: "pack",
  schema: z.object({ pack: z.string().regex(PACK_ID_RE, "非法主题包 id") }).strict(),
  describe: ({ pack }) => `主题包 → ${pack}`,
};

export const siteLogoEffect: CampaignEffect<{ file: string }> = {
  key: "site.logo",
  label: "站点 LOGO",
  targetKey: "file",
  schema: z.object({ file: z.string().regex(LOGO_FILE_RE, "非法 LOGO 池文件名") }).strict(),
  describe: ({ file }) => `LOGO → ${file}`,
};

export const siteHeroEffect: CampaignEffect<{ file: string }> = {
  key: "site.hero",
  label: "首页横幅",
  targetKey: "file",
  schema: z.object({ file: z.string().regex(HERO_FILE_RE, "非法 Hero 池文件名") }).strict(),
  describe: ({ file }) => `首页横幅 → ${file}`,
};

/**
 * 全部已注册 effect。
 * 新增一项 = 在这里 push + 在 site-chrome 的合成里接上消费 + 补 effects.test 的键清单断言。
 */
export const CAMPAIGN_EFFECTS: readonly CampaignEffect<never>[] = [
  themePackEffect,
  siteLogoEffect,
  siteHeroEffect,
] as unknown as readonly CampaignEffect<never>[];

/** 按注册键取 effect；未知键返回 null（读侧：该行不生效；写侧：拒绝保存） */
export function findCampaignEffect(key: string): CampaignEffect<never> | null {
  return CAMPAIGN_EFFECTS.find((effect) => effect.key === key) ?? null;
}

/** 注册键集合（读写两侧共用，避免两处各写一份清单） */
export const CAMPAIGN_EFFECT_KEYS: readonly string[] = CAMPAIGN_EFFECTS.map((effect) => effect.key);

/**
 * 校验一条方案的配置：未知 effect 或配置不合法都返回错误说明。
 * 纯函数、无 IO——引用的存在性（包是否启用、池文件是否存在）由写服务另行校验。
 */
export function validateCampaignConfig(
  effect: string,
  config: unknown,
): { ok: true; value: unknown } | { ok: false; message: string } {
  const registered = findCampaignEffect(effect);
  if (!registered) return { ok: false, message: `未注册的效果类型：${effect}` };
  const parsed = registered.schema.safeParse(config);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.join(".") || "(根)";
    return { ok: false, message: `${where}: ${first?.message ?? "配置无效"}` };
  }
  return { ok: true, value: parsed.data };
}

/** 后台卡片摘要：配置无效或效果未注册时给出明确文案，类型擦除只在这一处处理 */
export function describeCampaign(effect: string, config: unknown): string {
  const registered = findCampaignEffect(effect);
  if (!registered) return `未注册的效果：${effect}`;
  const parsed = registered.schema.safeParse(config);
  if (!parsed.success) return "配置无效（读取时会被忽略）";
  return (registered.describe as (value: unknown) => string)(parsed.data);
}

/** 由表单提交的目标值组装配置；未注册 effect 返回 null */
export function configFromTarget(effect: string, target: string): Record<string, string> | null {
  const registered = findCampaignEffect(effect);
  return registered ? { [registered.targetKey]: target } : null;
}

/** 从已存配置取出目标值（编辑回填、引用校验用）；形态不符返回 null */
export function targetOfConfig(effect: string, config: unknown): string | null {
  const registered = findCampaignEffect(effect);
  if (!registered || typeof config !== "object" || config === null) return null;
  const value = (config as Record<string, unknown>)[registered.targetKey];
  return typeof value === "string" ? value : null;
}
