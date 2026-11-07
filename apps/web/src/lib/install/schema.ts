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

export const installConfigSchema = z
  .object({
    db: z
      .object({
        host: z.string().min(1).max(255),
        port: z.number().int().min(1).max(65535),
        user: z.string().min(1).max(64),
        password: z.string().max(128),
        name: z
          .string()
          .regex(INSTALL_DATABASE_NAME_RE, "数据库名只允许字母、数字与下划线（1–64 位）"),
      })
      .strict(),
    site: z
      .object({
        name: z.string().trim().min(1).max(40),
        tagline: z.string().trim().max(80),
        url: z
          .string()
          .trim()
          .regex(/^https?:\/\//, "站点 URL 必须以 http:// 或 https:// 开头"),
      })
      .strict(),
    themePack: z.enum(INSTALL_THEME_PACKS),
    registration: installRegistrationSchema,
    admin: z
      .object({
        username: z.string().trim(),
        email: z.string().trim(),
        password: z.string(),
      })
      .strict(),
  })
  .strict();

export type InstallConfig = z.infer<typeof installConfigSchema>;
export type InstallRegistration = z.infer<typeof installRegistrationSchema>;

/** 按字段收集的问题说明（G-15 上游：页面文案表的键从这里来） */
export type InstallConfigIssues = Record<string, string>;

/**
 * 校验安装配置。除 zod 结构校验外还有三条语义规则：
 *  · 管理员用户名走注册同款规则（checkUsername）、邮箱格式、密码 ≥8 位（与注册口径一致）；
 *  · db 连接信息必须与**运行中实例的环境变量**（newDbConfig()）完全一致——
 *    向导/CLI 跑在已按 .env 启动的进程里，改表单里的连接信息并不能让运行中的实例换库（F12/规划 §2.1）；
 *  · 管理员用户名不得等于保留字（checkUsername 内含保留字与字符集规则）。
 */
export function validateInstallConfig(
  raw: unknown,
  runtimeDb = newDbConfig(),
): { ok: true; value: InstallConfig } | { ok: false; issues: InstallConfigIssues } {
  const parsed = installConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues: InstallConfigIssues = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".") || "(根)";
      issues[key] ??= issue.message;
    }
    return { ok: false, issues };
  }
  const value = parsed.data;
  const issues: InstallConfigIssues = {};

  const nameCheck = checkUsername(value.admin.username);
  if (!nameCheck.ok) issues["admin.username"] = nameCheck.message;
  if (!isValidEmail(value.admin.email)) issues["admin.email"] = "邮箱格式不正确";
  if (value.admin.password.length < 8) issues["admin.password"] = "密码至少 8 位";

  const db = value.db;
  const mismatches: string[] = [];
  if (db.host !== runtimeDb.host) mismatches.push(`主机（应为 ${runtimeDb.host}）`);
  if (db.port !== runtimeDb.port) mismatches.push(`端口（应为 ${runtimeDb.port}）`);
  if (db.user !== runtimeDb.user) mismatches.push(`用户（应为 ${runtimeDb.user}）`);
  if (db.password !== runtimeDb.password) mismatches.push("口令");
  if (db.name !== runtimeDb.database) mismatches.push(`库名（应为 ${runtimeDb.database}）`);
  if (mismatches.length > 0) {
    issues["db"] =
      `数据库连接信息与运行中实例的环境变量不一致（${mismatches.join("、")}）：` +
      "安装只能写入本实例配置的库——请保持表单默认值，或修改 .env 后重启实例再运行安装。";
  }

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
    themePack: "default",
    registration: { mode: "invite" },
    admin: { username: "", email: "", password: "", ...overrides.admin },
    ...overrides,
  });
}
