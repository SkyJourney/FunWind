import "server-only";

import { eq } from "drizzle-orm";
import { getWebDb, siteSettings } from "@funwind/db";
import { z } from "zod";
import type { ConfigActor } from "@/lib/audit";
import { applySettingInTx } from "@/lib/auth/settings";
import { invalidateSiteChrome } from "@/lib/chrome/site-chrome";
import { limitsConfigSchema, parseLimitsConfig } from "@/lib/limits/config";
import type {
  ModerationApiTrace,
  ModerationWriteDenial,
  PreparedModerationWrite,
} from "@/lib/moderation/contents";

/**
 * 站点设置分组白名单 + zod 适配层（M20.3 Step 5）：管理 REST 按「分组」读写 site_settings。
 * 各组 schema 从后台 Action 的表单输入收拢为结构化 JSON（nav/links 由「名称,路径」逐行文本
 * 改为结构化数组），复用后台的事务写入内核（行锁 + 真实值变化才审计 setting.update）。
 * REST 审计前后值使用与读取相同的投影，并在 after 附加 trace；后台 Action 不经此模块，
 * 表单与审计形态保持不变。
 *
 * 红线（docs/EMAIL-SCENARIOS.md 站长裁决）：SMTP URL/凭据只在 env，永不入库——email 语义
 * 分组只含站点级开关与发送时刻，不含 SMTP 配置；发信测试（sendTestMailAction）是动作不是
 * 配置，不进分组白名单。读侧按分组允许的字段投影。
 */

// ---------- 各组 zod schema（REST 输入与后台表单字段一一对应；额外字段一律拒绝） ----------

/**
 * identity（site.identity）：镜像 saveIdentityAction 的表单校验；url 落库前去尾斜杠
 * （与后台 run 同款归一，读侧 parseIdentity 也按去尾斜杠口径解析）。
 */
const identitySchema = z.strictObject({
  name: z.string().trim().min(1, "站点名不能为空").max(40),
  tagline: z.string().trim().max(80).default(""),
  url: z
    .string()
    .trim()
    .max(200)
    .default("")
    .refine((v) => v === "" || isHttpUrl(v), {
      message: "访问地址需以 http(s):// 开头",
    })
    .transform((v) => (v === "" ? "" : v.replace(/\/+$/, ""))),
});

/**
 * 注册策略完整替换：要求显式提供三个布尔值，避免遗漏字段时关闭注册。
 */
const registerPolicyInputSchema = z.strictObject({
  open: z.boolean(),
  invite: z.boolean(),
  verifyEmail: z.boolean(),
});

const nonNeg = (max: number) => z.number().int().min(0).max(max);

/**
 * limits（limits）：镜像 saveLimitsAction 的站点级两项（titleMax/bodyMax）和 member/admin
 * 两内置角色的五项额度，但 REST 只接受 JSON 整数，不做后台表单的字符串转换。
 * 其余角色在锁内合并保留，整体再过 limitsConfigSchema 校验，避免无效配置回落默认值。
 */
const limitsInputSchema = z.strictObject({
  titleMax: z.number().int().min(1).max(255),
  bodyMax: z.number().int().min(1).max(1_000_000),
  memberPostIntervalSec: nonNeg(3600),
  memberThreadsPerDay: nonNeg(100_000),
  memberUploadsPerDay: nonNeg(100_000),
  memberPmPerDay: nonNeg(100_000),
  memberEditWindowSec: nonNeg(31_536_000),
  adminPostIntervalSec: nonNeg(3600),
  adminThreadsPerDay: nonNeg(100_000),
  adminUploadsPerDay: nonNeg(100_000),
  adminPmPerDay: nonNeg(100_000),
  adminEditWindowSec: nonNeg(31_536_000),
});

/**
 * 站点级统一开关（email.security / email.ops / push.enabled）：后台 checkbox 缺席 = false 的
 * 语义由表单层承担；REST 必须显式给出布尔，缺字段按 bad_request 拒绝，不静默改开关。
 */
const enabledFlagSchema = z.strictObject({ enabled: z.boolean() });

/** email.digest：每日汇总发送时刻（0–23 点；进程内调度器按北京墙面时间比对）。 */
const digestHourSchema = z.strictObject({ hour: z.number().int().min(0).max(23) });

const SITE_PATH_ORIGIN = "https://funwind.invalid";

/** 站内路径用固定基准校验，不依赖请求头或站点的可编辑地址。 */
function isSitePath(raw: string): boolean {
  // 在裁剪和 URL 解析前拒绝 ASCII 控制字符，避免字符被静默丢弃。
  if (/[\x00-\x1f\x7f]/.test(raw)) return false;
  const value = raw.trim();
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return false;
  try {
    return new URL(value, SITE_PATH_ORIGIN).origin === SITE_PATH_ORIGIN;
  } catch {
    return false;
  }
}

function isHttpUrl(value: string): boolean {
  if (!/^https?:\/\//.test(value)) return false;
  try {
    const url = new URL(value);
    return Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * nav（site.nav）：后台是「名称,路径」逐行文本，REST 改为结构化数组。
 * 长度上限对齐读侧展示截断（label 32 / href 200），超限直接拒绝；写入至多 20 条，前台仍渲染前 10 条。
 */
const navItemSchema = z.strictObject({
  label: z.string().trim().min(1).max(32),
  href: z
    .string()
    .refine(isSitePath, { message: "导航项路径必须以 / 开头（只能是站内路径）" })
    .trim()
    .min(1)
    .max(200),
});
const navItemsSchema = z.array(navItemSchema).max(20);

/**
 * links（site.links）：后台行格式「名称,路径」（parseLinesChecked，hrefMustBePath: false），
 * REST 为结构化数组——href 允许站内路径（/ 开头）或 http(s) 外链，label/href 上限对齐
 * 读侧 parseLinks 的展示截断（label 32 / href 300），条数沿用写侧 20 条封顶。
 */
const linkItemSchema = z.strictObject({
  label: z.string().trim().min(1).max(32),
  href: z
    .string()
    .refine((raw) => isSitePath(raw) || isHttpUrl(raw.trim()), {
      message: "链接必须是站内路径（/ 开头）或 http(s):// 链接",
    })
    .trim()
    .min(1)
    .max(300),
});
const linkItemsSchema = z.array(linkItemSchema).max(20);

/** footer（site.footer）：页脚文本（后台 saveFooterAction 的 footerText，上限 300）。 */
const footerSchema = z.strictObject({ text: z.string().max(300).default("") });

// ---------- 分组白名单常量 ----------

/** 组 zod 解析产物：value 为 setSetting 的落库值；失败带首个 issue 的「路径: 消息」。 */
type GroupParse = { ok: true; value: unknown } | { ok: false; message: string };

/** 分组表项：site_settings 实际键 + REST 输入 zod + 应用逻辑 + 描述。 */
interface SettingsGroupEntry {
  /** 实际落库的 site_settings 键 */
  key: string;
  /** REST 输入 zod（对外契约；resolve 内部即用它解析） */
  schema: z.ZodType;
  /** 校验并产出落库值（limits 使用锁内现值合并） */
  resolve(input: unknown, previous: unknown): Promise<GroupParse>;
  /** 分组描述（文档与管理界面展示用） */
  description: string;
}

/**
 * zod 解析 → 统一产物：失败取首个 issue 拼「路径: 消息」（进 bad_request 的 message）。
 * 泛型 S 保留具体输出类型，limits 的 merge 不需要二次断言。
 */
function zodParse<S extends z.ZodType>(
  schema: S,
  input: unknown,
): { ok: true; value: z.output<S> } | { ok: false; message: string } {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first && first.path.length > 0 ? `${first.path.map(String).join(".")}: ` : "";
    return { ok: false, message: `${where}${first?.message ?? "输入格式不正确"}` };
  }
  return { ok: true, value: parsed.data };
}

/**
 * 设置分组白名单（M20.3 Step 5）：REST 允许读写的全部组。键 = REST 分组名，
 * `key` = 实际 site_settings 键。SMTP 相关配置不在此表（env 红线）。
 */
export const SETTINGS_GROUPS = {
  /** 站点身份（M10.6b）：名称 / 副标题 / 对外访问地址 */
  identity: {
    key: "site.identity",
    schema: identitySchema,
    description: "站点身份：名称 / 副标题 / 对外访问地址",
    async resolve(input: unknown) {
      return zodParse(identitySchema, input);
    },
  },
  /** 注册策略（M11.3）：开放注册 / 邀请注册 / 开放注册需验证邮箱 */
  register: {
    key: "register.policy",
    schema: registerPolicyInputSchema,
    description: "注册策略：开放注册 / 邀请注册 / 开放注册需验证邮箱",
    async resolve(input: unknown) {
      return zodParse(registerPolicyInputSchema, input);
    },
  },
  /** 频控（M6.1）：站点级字数上限 + member/admin 额度；其余角色 merge 现值保留 */
  limits: {
    key: "limits",
    schema: limitsInputSchema,
    description: "频控：标题/正文字数上限与 member/admin 发帖、上传、私信、编辑时限额度",
    async resolve(input: unknown, previous: unknown) {
      const parsed = zodParse(limitsInputSchema, input);
      if (!parsed.ok) return parsed;
      // merge 现值只改已知字段（member/admin 两内置角色 + 站点级两项），其余角色原值保留；
      // 整体过 limitsConfigSchema——写坏配置会整体回落默认值（load.ts 口径），必须在这里拦住
      const current = parseLimitsConfig(previous).config;
      return zodParse(limitsConfigSchema, {
        titleMax: parsed.value.titleMax,
        bodyMax: parsed.value.bodyMax,
        roles: {
          ...current.roles,
          member: {
            postIntervalSec: parsed.value.memberPostIntervalSec,
            threadsPerDay: parsed.value.memberThreadsPerDay,
            uploadsPerDay: parsed.value.memberUploadsPerDay,
            pmPerDay: parsed.value.memberPmPerDay,
            editWindowSec: parsed.value.memberEditWindowSec,
          },
          admin: {
            postIntervalSec: parsed.value.adminPostIntervalSec,
            threadsPerDay: parsed.value.adminThreadsPerDay,
            uploadsPerDay: parsed.value.adminUploadsPerDay,
            pmPerDay: parsed.value.adminPmPerDay,
            editWindowSec: parsed.value.adminEditWindowSec,
          },
        },
      });
    },
  },
  /** 安全强制类邮件统一开关（S1–S3；用户侧不可关） */
  "email.security": {
    key: "email.security",
    schema: enabledFlagSchema,
    description: "安全强制类邮件的站点统一开关（用户侧不可关）",
    async resolve(input: unknown) {
      return zodParse(enabledFlagSchema, input);
    },
  },
  /** 运维告警邮件统一开关（M17 Step 2；ops.run.failed 管线任务失败通知管理员） */
  "email.ops": {
    key: "email.ops",
    schema: enabledFlagSchema,
    description: "运维告警邮件的站点统一开关（管线任务失败时通知管理员）",
    async resolve(input: unknown) {
      return zodParse(enabledFlagSchema, input);
    },
  },
  /** Web Push 站点级总开关（M18 Step 6，D4）：出问题可一键停推 */
  "push.enabled": {
    key: "push.enabled",
    schema: enabledFlagSchema,
    description: "Web Push 站点级总开关（出问题可一键停推）",
    async resolve(input: unknown) {
      return zodParse(enabledFlagSchema, input);
    },
  },
  /** 每日汇总发送时刻（S7；0–23 点） */
  "email.digest": {
    key: "email.digest",
    schema: digestHourSchema,
    description: "每日汇总邮件的发送时刻（0–23 点）",
    async resolve(input: unknown) {
      return zodParse(digestHourSchema, input);
    },
  },
  /** 站点导航项（M19 Q3）：结构化数组（后台仍是逐行文本） */
  nav: {
    key: "site.nav",
    schema: navItemsSchema,
    description: "站点导航项：label + 站内路径（/ 开头）",
    async resolve(input: unknown) {
      return zodParse(navItemsSchema, input);
    },
  },
  /** 友链（M19 Q3）：结构化数组（后台仍是逐行文本） */
  links: {
    key: "site.links",
    schema: linkItemsSchema,
    description: "友链：label + 站内路径（/ 开头）或 http(s):// 外链",
    async resolve(input: unknown) {
      return zodParse(linkItemsSchema, input);
    },
  },
  /** 页脚文本（M19 Q3） */
  footer: {
    key: "site.footer",
    schema: footerSchema,
    description: "页脚文本（≤300 字）",
    async resolve(input: unknown) {
      return zodParse(footerSchema, input);
    },
  },
} as const satisfies Record<string, SettingsGroupEntry>;

/** 合法分组名（REST 路径参数的取值集合）。 */
export type SettingsGroup = keyof typeof SETTINGS_GROUPS;

/** 站点框架缓存直接消费这五组设置；其他分组不依赖此缓存。 */
const SITE_CHROME_GROUPS: ReadonlySet<SettingsGroup> = new Set([
  "identity",
  "register",
  "nav",
  "links",
  "footer",
]);

/** 常量表按字符串查表用（未知分组返回 undefined，由调用方转 unknown_group 拒绝）。 */
function isSettingsGroup(group: string): group is SettingsGroup {
  return Object.hasOwn(SETTINGS_GROUPS, group);
}

// ---------- 读 / 写服务 ----------

export type SettingsGroupRead =
  | { ok: true; group: string; key: string; value: unknown; updatedAt: string | null }
  | ModerationWriteDenial<"unknown_group">;

/**
 * 按组读 site_settings 现值：直接读行，不回落默认值——REST 读的是「库里存了什么」，
 * 未配置（无行）时 value/updatedAt 为 null。所有组均按白名单投影。
 */
export async function readSettingsGroup(group: string): Promise<SettingsGroupRead> {
  if (!isSettingsGroup(group)) {
    return { ok: false as const, code: "unknown_group" as const, message: "未知的设置分组" };
  }
  const entry = SETTINGS_GROUPS[group];
  const [row] = await getWebDb()
    .select({ value: siteSettings.value, updatedAt: siteSettings.updatedAt })
    .from(siteSettings)
    .where(eq(siteSettings.key, entry.key))
    .limit(1);
  if (!row) {
    return { ok: true as const, group, key: entry.key, value: null, updatedAt: null };
  }
  return {
    ok: true as const,
    group,
    key: entry.key,
    value: projectSetting(group, row.value),
    updatedAt: row.updatedAt,
  };
}

/** 只读出各组契约显式声明的字段，避免回显库中额外存储的数据。 */
function projectSetting(group: SettingsGroup, value: unknown): unknown {
  if (group === "limits") return limitsConfigSchema.safeParse(value).data ?? null;
  const schema = SETTINGS_GROUPS[group].schema;
  if (schema instanceof z.ZodObject) return schema.strip().safeParse(value).data ?? null;
  return schema.safeParse(value).data ?? null;
}

/** 业务拒绝码 → 对外信封映射（REST 适配层使用；未登记码由入口兜底 internal）。 */
export const SETTINGS_DENIAL_HTTP = {
  unknown_group: "not_found",
  bad_request: "bad_request",
} as const;

export type PreparedApiSettingsGroup = PreparedModerationWrite<
  { group: string; key: string },
  "unknown_group" | "bad_request"
>;

/** REST 更新设置分组：白名单与组 zod 在 prepare（事务外）；行锁与写入在幂等事务。 */
export async function prepareApiSettingsGroup(
  group: string,
  input: unknown,
  actor: ConfigActor,
  trace?: ModerationApiTrace,
): Promise<PreparedApiSettingsGroup | ModerationWriteDenial<"unknown_group" | "bad_request">> {
  if (!isSettingsGroup(group)) {
    return { ok: false, code: "unknown_group", message: "未知的设置分组" };
  }
  const entry: SettingsGroupEntry = SETTINGS_GROUPS[group];
  if (!entry.schema.safeParse(input).success) return { ok: false, code: "bad_request" };
  return {
    ok: true,
    async lock(tx) {
      const [previous] = await tx
        .select({ value: siteSettings.value })
        .from(siteSettings)
        .where(eq(siteSettings.key, entry.key))
        .for("update");
      return {
        ok: true,
        async execute() {
          const parsed = await entry.resolve(input, previous?.value);
          if (!parsed.ok) return { ok: false, code: "bad_request", message: parsed.message };
          await applySettingInTx(tx, entry.key, parsed.value, actor, {
            trace,
            projectAuditValue: (raw) => projectSetting(group, raw),
          });
          return {
            ok: true,
            data: { group, key: entry.key },
            // 幂等回放不进入执行段；只有本次真实提交才清除本进程的站点框架缓存。
            afterCommit: SITE_CHROME_GROUPS.has(group)
              ? async () => invalidateSiteChrome()
              : undefined,
          };
        },
      };
    },
  };
}
