import { z } from "zod";

/**
 * 运营排期效果（effect）注册表（M11.2，M11.4 Step 0 扩展，docs/milestones/M11.2-theme-switching.md / M11.4-campaign-behavior-effects.md）。
 *
 * 一个 effect = 一种「被排期临时覆盖的站点生效值」。M11.2 注册视觉类三项（主题包 / LOGO / Hero）；
 * M11.4 起扩展为可容纳行为类（开放注册窗口、积分加成等），新增效果仍只加注册项 + 接消费点，不改表、不改读取骨架。
 *
 * 设计约束（来自全仓既有范式与一次失败教训）：
 *  · 未知 effect 键在**读、写两侧都拒绝**（fail-closed）——同 lib/points/channels 的「未注册即拒」。
 *    但这里是"读配置"方向，拒绝的形态是"该行不生效"，不是抛错：一条坏方案不该让整站白屏。
 *  · 注册表必须同时有消费者（apps/web/src/lib/chrome/site-chrome.ts 的合成），
 *    只加类型不加消费 = 名义可插拔（docs/GATES.md §M6.1 修订记录的反例）。
 *  · schema 一律 `.strict()`：多一个字段就拒绝，防止把拼写错误静默变成默认值。
 *  · 表单沿用单个分组下拉 `<effect>::<选项值>`（无脚本可用，M11.4 D1）。后台提交值恒为字符串且不做类型转换
 *    （lib/actions/form-data.ts），所以「选项值 ⇄ 配置」的互转由每个 effect 自己负责（toConfig / toValue），
 *    不再假设"每个 effect 恰有一个字符串目标字段"——无参数、数值参数的行为类效果由此得以表达。
 */

/** 效果类别：visual 只替换读取到的站点默认值（无副作用）；behavior 在时间窗内改变业务决策点，有不可回滚的副作用（M11.4） */
export type CampaignEffectKind = "visual" | "behavior";

/** effect 配置的公共形态：纯数据，可 JSON 序列化，不含 URL / 路径 / CSS 文本 */
export interface CampaignEffect<C> {
  /** 注册键，落 campaigns.effect 列（varchar 32） */
  readonly key: string;
  /** 后台展示名 */
  readonly label: string;
  /** 类别：后台列表据此区分视觉类 / 行为类（M11.4） */
  readonly kind: CampaignEffectKind;
  /** 配置的严格校验；未知字段拒绝 */
  readonly schema: z.ZodType<C>;
  /** 该效果的一行摘要（纯函数，不含 IO；列表摘要与测试断言用） */
  readonly describe: (config: C) => string;
  /** 下拉选项值 → 待校验配置；值不合法返回 null（写入侧再由 schema 严格校验） */
  readonly toConfig: (value: string) => Record<string, unknown> | null;
  /** 已存配置 → 下拉选项值（编辑回填、列表摘要用）；形态不符返回 null */
  readonly toValue: (config: unknown) => string | null;
  /** 行为类自带下拉选项（无 IO，[选项值, 展示名]）；视觉类不设，选项由页面按库里的包与素材池生成 */
  readonly fixedOptions?: readonly (readonly [string, string])[];
}

/** 主题包 id 语法（与 lib/theme/packs.ts 的 THEME_PACK_ID_RE 同口径，避免循环依赖故本地重复） */
const PACK_ID_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
/** 素材池文件名：宽松口径（兼容历史短名），与 lib/brand/brand-pool.ts 的 safeNameOf 一致 */
const LOGO_FILE_RE = /^logo-[a-z0-9]+\.png$/;
const HERO_FILE_RE = /^hero-[a-z0-9]+\.png$/;

/**
 * 单字符串目标字段的通用互转（M11.2 三个视觉效果共用）：选项值填进唯一字段；
 * toValue 只做形态提取（与 M11.2 既有口径一致，不做语法复核）。
 */
function stringFieldConverters(field: "pack" | "file", pattern: RegExp) {
  return {
    toConfig: (value: string): Record<string, unknown> | null =>
      pattern.test(value) ? { [field]: value } : null,
    toValue: (config: unknown): string | null => {
      if (typeof config !== "object" || config === null) return null;
      const value = (config as Record<string, unknown>)[field];
      return typeof value === "string" ? value : null;
    },
  } as const;
}

export const themePackEffect: CampaignEffect<{ pack: string }> = {
  key: "theme.pack",
  label: "主题包",
  kind: "visual",
  schema: z.object({ pack: z.string().regex(PACK_ID_RE, "非法主题包 id") }).strict(),
  describe: ({ pack }) => `主题包 → ${pack}`,
  ...stringFieldConverters("pack", PACK_ID_RE),
};

export const siteLogoEffect: CampaignEffect<{ file: string }> = {
  key: "site.logo",
  label: "站点 LOGO",
  kind: "visual",
  schema: z.object({ file: z.string().regex(LOGO_FILE_RE, "非法 LOGO 池文件名") }).strict(),
  describe: ({ file }) => `LOGO → ${file}`,
  ...stringFieldConverters("file", LOGO_FILE_RE),
};

export const siteHeroEffect: CampaignEffect<{ file: string }> = {
  key: "site.hero",
  label: "首页横幅",
  kind: "visual",
  schema: z.object({ file: z.string().regex(HERO_FILE_RE, "非法 Hero 池文件名") }).strict(),
  describe: ({ file }) => `首页横幅 → ${file}`,
  ...stringFieldConverters("file", HERO_FILE_RE),
};

/**
 * M11.4 行为类 effect：开放注册窗口。
 * 配置恒为空对象 `{}`（无参数）：窗口生效即「访客可凭邮箱注册」，且窗口内强制要求验证邮箱（D3，
 * 叠加规则见 lib/auth/register-policy.ts 的 applyRegisterWindow）；窗口结束回到站点设置原值。
 * 与视觉类的本质差异：窗口内创建的账号不可回滚，保存校验更严（行为类不能时间重叠、必须有结束时间，见 admin.ts / input.ts）。
 */
export const registerOpenEffect: CampaignEffect<Record<string, never>> = {
  key: "register.open",
  label: "开放注册窗口",
  kind: "behavior",
  schema: z.object({}).strict(),
  describe: () => "临时开放注册（到期回到站点设置）",
  toConfig: (value) => (value === "on" ? {} : null),
  toValue: (config) =>
    typeof config === "object" && config !== null && Object.keys(config).length === 0 ? "on" : null,
  fixedOptions: [["on", "开放注册（窗口内注册须验证邮箱）"]],
};

/**
 * M11.4 行为类 effect：积分加成。
 * 配置 `{ratio: 2 | 3}`（站长 D2：只给两档，加档只改这里）；作用渠道限 earn.post / earn.reply /
 * earn.checkin。金额乘倍率、日上限同比放大（上限 0 仍不限）、幂等键不变、台账 note 注明
 * 「活动加成 ×N：方案名」便于追溯（实现见 lib/points/boost.ts 与 earn/checkin 的消费点）。
 * 与视觉类的本质差异：加成期内发出的积分不可回滚，保存校验更严（不能重叠、必须填结束时间）。
 */
export const pointsBoostEffect: CampaignEffect<{ ratio: number }> = {
  key: "points.boost",
  label: "积分加成",
  kind: "behavior",
  schema: z.object({ ratio: z.number().int().min(2).max(3, "倍率只支持 2 或 3") }).strict(),
  describe: ({ ratio }) => `积分 ×${ratio} 加成`,
  toConfig: (value) => {
    // 只认字面量 "2" / "3"（Number() 会把 "02" / "2e0" 宽松解析成合法数字，拒绝之）
    const ratio = value === "2" ? 2 : value === "3" ? 3 : null;
    return ratio === null ? null : { ratio };
  },
  toValue: (config) => {
    if (typeof config !== "object" || config === null) return null;
    const ratio = (config as { ratio?: unknown }).ratio;
    return ratio === 2 || ratio === 3 ? String(ratio) : null;
  },
  fixedOptions: [
    ["2", "积分 ×2 加成"],
    ["3", "积分 ×3 加成"],
  ],
};

/**
 * 全部已注册 effect。
 * 新增一项 = 在这里 push + 在读取链接上消费（视觉类 site-chrome；行为类各自的决策点）+ 补 effects.test 的键清单断言；
 * 行为类还要接 refs（无外部引用则返回 true）与 admin 的重叠检查（kind=behavior 自动生效）。
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

/**
 * 由表单提交的选项值组装配置；effect 未注册或值不合法返回 null。
 * 配置值可以是数字（points.boost 的 ratio）：合法性由各 effect 的 toConfig 自行把关，
 * 写入侧再经 schema 严格校验——不再做「值必须是字符串」的单目标时代收窄。
 */
export function configFromTarget(effect: string, target: string): Record<string, unknown> | null {
  const registered = findCampaignEffect(effect);
  return registered ? registered.toConfig(target) : null;
}

/** 从已存配置取出选项值（编辑回填、引用校验、列表摘要用）；形态不符返回 null */
export function targetOfConfig(effect: string, config: unknown): string | null {
  const registered = findCampaignEffect(effect);
  return registered ? registered.toValue(config) : null;
}
