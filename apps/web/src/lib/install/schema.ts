import { z } from "zod";
import { newDbConfig } from "@funwind/db";
import { checkUsername } from "@/lib/auth/username";
import { isValidEmail } from "@/lib/auth/email";

/**
 * 安装配置（M12）：向导表单与 CLI 共用同一份 schema——strict 拒绝未知字段，
 * 语义校验（用户名规则 / 邮箱格式 / 密码长度 / 库名安全 / 与运行实例的环境一致）集中在
 * `validateInstallConfig`，问题按字段返回中文说明（G-15：错误与页面文案成对的上游来源）。
 */

/** 库名白名单：CREATE DATABASE 语句按此校验后拼接，杜绝注入与非法字符 */
export const INSTALL_DATABASE_NAME_RE = /^[A-Za-z0-9_]{1,64}$/;

/** 可选的出厂主题包：与 packages/db 的内置主题包种子保持同步（有漂移哨兵测试） */
export const INSTALL_THEME_PACKS = ["default", "qy2010"] as const;
export type InstallThemePack = (typeof INSTALL_THEME_PACKS)[number];

export const installRegistrationSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("open"), verifyEmail: z.boolean() }).strict(),
  z.object({ mode: z.literal("invite") }).strict(),
  z.object({ mode: z.literal("closed") }).strict(),
]);

/** 分步表单的切片 schema（向导每一步只提交自己那份；CLI 仍用完整 installConfigSchema）。
 * 字段文案一律中文（G-15：结构校验失败的提示也会直出 UI，不能落 zod 默认英文）。 */
export const installDbSchema = z.object({
  host: z.string({ message: "主机必须为字符串" }).min(1, "主机不能为空").max(255, "主机过长"),
  port: z
    .number({ message: "端口必须是 1–65535 的整数" })
    .int("端口必须是 1–65535 的整数")
    .min(1, "端口必须是 1–65535 的整数")
    .max(65535, "端口必须是 1–65535 的整数"),
  user: z.string({ message: "用户必须为字符串" }).min(1, "用户不能为空").max(64, "用户过长"),
  password: z.string({ message: "口令必须为字符串" }).max(128, "口令过长"),
  name: z
    .string({ message: "数据库名必须为字符串" })
    .regex(INSTALL_DATABASE_NAME_RE, "数据库名只允许字母、数字与下划线（1–64 位）"),
});

export const installSiteSchema = z.object({
  name: z
    .string({ message: "站点名称必须为字符串" })
    .trim()
    .min(1, "站点名称不能为空")
    .max(40, "站点名称过长"),
  tagline: z.string({ message: "一句话介绍必须为字符串" }).trim().max(80, "一句话介绍过长"),
  url: z
    .string({ message: "站点 URL 必须为字符串" })
    .trim()
    .regex(/^https?:\/\//, "站点 URL 必须以 http:// 或 https:// 开头"),
});

export const installAdminSchema = z
  .object({
    username: z.string().trim(),
    email: z.string().trim(),
    password: z.string(),
  })
  .strict();

/** 站点切片语义校验：名称必填、URL 形态（zod installSiteSchema 的 run 侧包装） */
export function validateSiteSlice(
  site: unknown,
):
  | { ok: true; value: z.infer<typeof installSiteSchema> }
  | { ok: false; issues: InstallConfigIssues } {
  const parsed = installSiteSchema.safeParse(site);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, issues: zodIssues(parsed.error) };
}

export const installConfigSchema = z
  .object({
    db: installDbSchema,
    site: installSiteSchema,
    themePack: z.enum(INSTALL_THEME_PACKS),
    registration: installRegistrationSchema,
    admin: installAdminSchema,
  })
  .strict();

export type InstallConfig = z.infer<typeof installConfigSchema>;
export type InstallRegistration = z.infer<typeof installRegistrationSchema>;

/** 按字段收集的问题说明（G-15 上游：页面文案表的键从这里来） */
export type InstallConfigIssues = Record<string, string>;

/** zod safeParse 的 issues → 按路径归并的字段问题 */
export function zodIssues(error: z.ZodError): InstallConfigIssues {
  const issues: InstallConfigIssues = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "(根)";
    issues[key] ??= issue.message;
  }
  return issues;
}

/** db 切片语义校验：连接信息必须与运行中实例的环境变量完全一致（运行中的进程不能换库） */
export function validateDbSlice(
  db: unknown,
  runtimeDb = newDbConfig(),
):
  | { ok: true; value: z.infer<typeof installDbSchema> }
  | { ok: false; issues: InstallConfigIssues } {
  const parsed = installDbSchema.safeParse(db);
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) };
  // 口令留空 = 沿用 .env 的值（审查 P1-1：口令不预填不回显，表单留空提交；CLI 传完整值不受影响）
  const submitted =
    parsed.data.password === "" ? { ...parsed.data, password: runtimeDb.password } : parsed.data;
  const mismatches: string[] = [];
  if (submitted.host !== runtimeDb.host) mismatches.push("主机");
  if (submitted.port !== runtimeDb.port) mismatches.push("端口");
  if (submitted.user !== runtimeDb.user) mismatches.push("用户");
  if (submitted.password !== runtimeDb.password) mismatches.push("口令");
  if (submitted.name !== runtimeDb.database) mismatches.push("库名");
  if (mismatches.length > 0) {
    // 不回显 env 的具体值：本页对公网匿名开放，值会泄露数据库拓扑（审查 P1-1）
    return {
      ok: false,
      issues: {
        db:
          `数据库连接信息与运行中实例的环境变量不一致（${mismatches.join("、")}）：` +
          "安装只能写入本实例配置的库——请保持表单默认值，或修改 .env 后重启实例再运行安装。",
      },
    };
  }
  return { ok: true, value: submitted };
}

/** 管理员切片语义校验：用户名规则 / 邮箱格式 / 密码长度（与注册口径一致） */
export function validateAdminSlice(
  admin: unknown,
):
  | { ok: true; value: z.infer<typeof installAdminSchema> }
  | { ok: false; issues: InstallConfigIssues } {
  const parsed = installAdminSchema.safeParse(admin);
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) };
  const issues: InstallConfigIssues = {};
  const nameCheck = checkUsername(parsed.data.username);
  if (!nameCheck.ok) issues["admin.username"] = nameCheck.message;
  if (!isValidEmail(parsed.data.email)) issues["admin.email"] = "邮箱格式不正确";
  if (parsed.data.password.length < 8) issues["admin.password"] = "密码至少 8 位";
  return Object.keys(issues).length === 0
    ? { ok: true, value: parsed.data }
    : { ok: false, issues };
}

/** 完整配置校验（CLI 一次性安装用）：db/site/admin 切片语义校验的组合 */
export function validateInstallConfig(
  raw: unknown,
  runtimeDb = newDbConfig(),
): { ok: true; value: InstallConfig } | { ok: false; issues: InstallConfigIssues } {
  const parsed = installConfigSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) };
  const value = parsed.data;
  const issues: InstallConfigIssues = {};
  const dbCheck = validateDbSlice(value.db, runtimeDb);
  if (!dbCheck.ok) Object.assign(issues, dbCheck.issues);
  const adminCheck = validateAdminSlice(value.admin);
  if (!adminCheck.ok) Object.assign(issues, adminCheck.issues);
  return Object.keys(issues).length === 0 ? { ok: true, value } : { ok: false, issues };
}

/**
 * 从运行实例的环境变量组装默认配置（向导表单预填与 CLI 非交互的同一来源）：
 * db 五项来自 newDbConfig()（保证与运行实例一致），其余字段由调用方覆盖。
 */
export function installConfigFromEnv(
  overrides: Partial<Omit<InstallConfig, "db">> & { db?: Partial<InstallConfig["db"]> } = {},
): InstallConfig {
  const env = newDbConfig();
  // 注意：外层不能再展开 overrides——那会用**部分** db/site/admin 对象整体覆盖上面合并好的完整值，
  // 使签名承诺的 Partial 语义失效（审查 P2-②）
  return installConfigSchema.parse({
    db: {
      host: env.host,
      port: env.port,
      user: env.user,
      password: env.password,
      name: env.database,
      ...overrides.db,
    },
    site: {
      name: "青翼字幕组",
      tagline: "日语·ACG 情怀社区",
      url: "http://127.0.0.1:3100",
      ...overrides.site,
    },
    themePack: overrides.themePack ?? "default",
    registration: overrides.registration ?? { mode: "invite" },
    admin: { username: "", email: "", password: "", ...overrides.admin },
  });
}
