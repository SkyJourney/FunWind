import { z } from "zod";

/**
 * 运营排期效果（effect）注册表（M11.2 & M11.4，docs/milestones/M11.2-theme-switching.md / M11.4-campaign-behavior-effects.md）。
 *
 * 一个 effect = 一种「被排期临时覆盖的站点生效值」。M11.2 三个视觉类 effect，M11.4 扩展为行为类。
 *
 * 设计约束（来自全仓既有范式与一次失败教训）：
 *  · 未知 effect 键在**读、写两侧都拒绝**（fail-closed）——同 lib/points/channels 的「未注册即拒」。
 *    但这里是"读配置"方向，拒绝的形态是"该行不生效"，不是抛错：一条坏方案不该让整站白屏。
 *  · 注册表必须同时有消费者（apps/web/src/lib/chrome/site-chrome.ts 的合成），
 *    只加类型不加消费 = 名义可插拔（docs/GATES.md §M6.1 修订记录的反例）。
 *  · schema 一律 `.strict()`：多一个字段就拒绝，防止把拼写错误静默变成默认值。
 *  · M11.4 扩展：effect 自己声明字段形态（无参数、枚举选择、数值输入）；后台表单根据声明动态渲染；
 *    配置储存格式 campaigns.config 列不变，但新增 helper 函数处理多种形态的互转。
 */

/**
 * Effect 的字段定义：用于后台表单的动态渲染与校验。
 * 三种形态：
 *  · `none`：无参数，config 为空对象 `{}`
 *  · `select`：枚举选择，config 含一个字符串字段
 *  · `number`：数值输入，config 含数值字段
 */
export type FieldConfig =
  | { readonly type: "none" }
  | {
      readonly type: "select";
      /** 字段名（后台表单的下拉值落入这个字段） */
      readonly fieldName: string;
      /** schema for the field value */
      readonly schema: z.ZodType<string>;
      /** 后台表单的选项生成函数（无 IO，纯函数；返回 [value, label] 对，value 存入 config[fieldName] */
      readonly options: readonly (readonly [string, string])[];
    }
  | {
      readonly type: "number";
      /** 字段名 */
      readonly fieldName: string;
      /** schema for the field value */
      readonly schema: z.ZodType<number>;
      /** UI 提示（如 "2-3 的整数") */
      readonly hint?: string;
    };

/** effect 配置的公共形态：纯数据，可 JSON 序列化，不含 URL / 路径 / CSS 文本 */
export interface CampaignEffect<C = never> {
  /** 注册键，落 campaigns.effect 列（varchar 32） */
  readonly key: string;
  /** 后台展示名 */
  readonly label: string;
  /** 字段定义：后台表单据此渲染；effect 自己管理参数结构，不再假设单目标 */
  readonly field: FieldConfig;
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

/**
 * M11.2 三个视觉类 effect（迁移到新形态，field 改为 select 字段类型）
 */
export const themePackEffect: CampaignEffect<{ pack: string }> = {
  key: "theme.pack",
  label: "主题包",
  field: {
    type: "select",
    fieldName: "pack",
    schema: z.string().regex(PACK_ID_RE, "非法主题包 id"),
    options: [], // 由后台页面传入真实的主题包列表
  },
  schema: z.object({ pack: z.string().regex(PACK_ID_RE, "非法主题包 id") }).strict(),
  describe: ({ pack }) => `主题包 → ${pack}`,
};

export const siteLogoEffect: CampaignEffect<{ file: string }> = {
  key: "site.logo",
  label: "站点 LOGO",
  field: {
    type: "select",
    fieldName: "file",
    schema: z.string().regex(LOGO_FILE_RE, "非法 LOGO 池文件名"),
    options: [], // 由后台页面传入真实的 LOGO 列表
  },
  schema: z.object({ file: z.string().regex(LOGO_FILE_RE, "非法 LOGO 池文件名") }).strict(),
  describe: ({ file }) => `LOGO → ${file}`,
};

export const siteHeroEffect: CampaignEffect<{ file: string }> = {
  key: "site.hero",
  label: "首页横幅",
  field: {
    type: "select",
    fieldName: "file",
    schema: z.string().regex(HERO_FILE_RE, "非法 Hero 池文件名"),
    options: [], // 由后台页面传入真实的 Hero 列表
  },
  schema: z.object({ file: z.string().regex(HERO_FILE_RE, "非法 Hero 池文件名") }).strict(),
  describe: ({ file }) => `首页横幅 → ${file}`,
};

/**
 * M11.4 行为类 effect：开放注册窗口（无参数）
 * config 为空对象 {}；排期生效时临时把注册策略里的「开放注册」置真，到期回到站点设置的原值。
 * 只能放开不能收紧：窗口结束后必须恢复到站点设置的值。
 */
export const registerOpenEffect: CampaignEffect<Record<string, never>> = {
  key: "register.open",
  label: "开放注册窗口",
  field: { type: "none" },
  schema: z.object({}).strict(),
  describe: () => "临时开放注册（到期回到站点设置）",
};

/**
 * M11.4 行为类 effect：积分加成（整数倍率）
 * config: { ratio: 2 | 3 | ... }；作用渠道限 earn.post / earn.reply / earn.checkin。
 * 加成后的金额进入既有事务、日上限判定、幂等键，不改结构。
 * 台账 note 注明「（活动加成：方案名）」便于追溯。
 */
export const pointsBoostEffect: CampaignEffect<{ ratio: number }> = {
  key: "points.boost",
  label: "积分加成",
  field: {
    type: "number",
    fieldName: "ratio",
    schema: z.number().int().min(2).max(10),
    hint: "整数倍率，如 2 或 3",
  },
  schema: z
    .object({
      ratio: z.number().int().min(2).max(10, "倍率必须在 2-10 之间"),
    })
    .strict(),
  describe: ({ ratio }) => `积分 ${ratio}x 加成（${ratio} 倍）`,
};

/**
 * 全部已注册 effect。
 * 新增一项 = 在这里 push + 在 site-chrome / lib/auth/settings / lib/points/earn 等消费点接上 + 补 effects.test 的键清单断言。
 */
export const CAMPAIGN_EFFECTS: readonly CampaignEffect<never>[] = [
  themePackEffect,
  siteLogoEffect,
  siteHeroEffect,
  registerOpenEffect,
  pointsBoostEffect,
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

/**
 * 新 helper：根据表单字段值组装配置。支持多种字段类型。
 * @param effect 已注册的 effect key
 * @param fieldValue 表单字段值（类型取决于 effect.field.type）
 * @returns config 对象，或 null 如果 effect 未注册
 */
export function configFromFormValue(
  effect: string,
  fieldValue: unknown,
): Record<string, unknown> | null {
  const registered = findCampaignEffect(effect);
  if (!registered) return null;

  switch (registered.field.type) {
    case "none":
      return {};
    case "select":
    case "number":
      return { [registered.field.fieldName]: fieldValue };
    default:
      const _exhaustive: never = registered.field;
      return _exhaustive;
  }
}

/**
 * 新 helper：从已存配置取出表单字段值。支持多种字段类型。
 * 用于编辑页面回填、引用校验等。
 * @returns 字段值，或 null 如果 effect 未注册或配置形态不符
 */
export function formValueOfConfig(effect: string, config: unknown): unknown {
  const registered = findCampaignEffect(effect);
  if (!registered || typeof config !== "object" || config === null) return null;

  switch (registered.field.type) {
    case "none":
      // 无参数，没有字段值可取
      return null;
    case "select":
    case "number": {
      const value = (config as Record<string, unknown>)[registered.field.fieldName];
      return value ?? null;
    }
    default:
      const _exhaustive: never = registered.field;
      return _exhaustive;
  }
}

/**
 * 兼容旧 API：由表单提交的目标值组装配置；未注册 effect 返回 null
 * （仅限 M11.2 的三个 select effect，新 effect 应用 configFromFormValue）
 * @deprecated 使用 configFromFormValue 替代
 */
export function configFromTarget(effect: string, target: string): Record<string, string> | null {
  const config = configFromFormValue(effect, target);
  return config &&
    typeof config === "object" &&
    Object.values(config).every((v) => typeof v === "string")
    ? (config as Record<string, string>)
    : null;
}

/**
 * 兼容旧 API：从已存配置取出目标值（编辑回填、引用校验用）；形态不符返回 null
 * （仅限 M11.2 的三个 select effect，新 effect 应用 formValueOfConfig）
 * @deprecated 使用 formValueOfConfig 替代
 */
export function targetOfConfig(effect: string, config: unknown): string | null {
  const value = formValueOfConfig(effect, config);
  return typeof value === "string" ? value : null;
}
