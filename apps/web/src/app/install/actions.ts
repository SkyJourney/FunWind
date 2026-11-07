"use server";

import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { requireNotInstalled } from "@/lib/install/guard";
import { runInstallStep, type InstallErrorCode } from "@/lib/install/run-install";
import {
  INSTALL_THEME_PACKS,
  installConfigFromEnv,
  validateAdminSlice,
  validateDbSlice,
  validateSiteSlice,
  type InstallConfig,
  type InstallConfigIssues,
} from "@/lib/install/schema";
import { encodeInstallDraft, type InstallDraft } from "./draft";

/**
 * 安装向导的 Server Actions（M12 Step 3）：每一步一个 Action，与 CLI 共用同一份管线
 * （runInstallStep）。三重入口纪律：
 *  · defineAction `auth: "guest"`（游客可用——站点尚无任何用户）；
 *  · run 的**第一行**必须是入口守卫调用（lib/install/guard：lock 后 404，D2）；
 *  · 静态守卫 install-entry-guard.test.ts 扫描本文件与 page.tsx，入口漏挂即红。
 *
 * input schema 刻意收宽成全字符串（formDataToObject 不做类型转换）：
 * 结构性校验在 run 里走各切片 validator，失败 failTo 回显草稿与字段级问题（G-15/G-19）；
 * defineAction 自身的 strict-parse 404 只兜被篡改的请求。
 */

/** 失败跳转：错误码 + 草稿 + 字段级问题，全部进 query（G-19：保存失败不清空工作成果） */
function failTo(
  code: InstallErrorCode | "invalid-config",
  step: 1 | 2 | 3,
  draft: InstallDraft,
  issues?: InstallConfigIssues,
): never {
  const params = new URLSearchParams({ step: String(step), err: code });
  params.set("draft", encodeInstallDraft(draft));
  if (issues && Object.keys(issues).length > 0) {
    params.set("issues", encodeURIComponent(JSON.stringify(issues)));
  }
  redirect(`/install?${params.toString()}`);
}

// 不加 .strict()：Next 会往 POST 里注入 $ACTION_ID_* 内部字段，strict 会把它们判成未知键 → 404；
// 字段扁平收下（formDataToObject 不支持嵌套路径，与 campaigns 等表单同款；全字符串），
// 语义校验在 run 里走切片 validator
const step1Input = z.object({
  host: z.string(),
  port: z.string(),
  user: z.string(),
  password: z.string(),
  name: z.string(),
});

export const installDatabaseAction = defineAction({
  name: "install.database",
  auth: "guest",
  input: step1Input,
  async run(_ctx, input) {
    await requireNotInstalled();
    const db = {
      host: input.host,
      port: input.port,
      user: input.user,
      password: input.password,
      name: input.name,
    };
    // 口令不进失败草稿（审查 P1-1/F-6）：留空提交 = 沿用 .env（validateDbSlice 的空口令语义）
    const draft: InstallDraft = {
      db: { host: db.host, port: db.port, user: db.user, name: db.name },
    };
    const check = validateDbSlice({ ...db, port: Number(db.port) });
    if (!check.ok) failTo("invalid-config", 1, draft, check.issues);
    const config: InstallConfig = installConfigFromEnv({ db: check.value });
    for (const step of ["connection", "create-db", "bootstrap"] as const) {
      const result = await runInstallStep(step, config);
      if (!result.ok) failTo(result.code, 1, draft);
    }
    redirect("/install?step=2");
  },
});

const step2Input = z.object({
  name: z.string(),
  tagline: z.string(),
  url: z.string(),
  themePack: z.string(),
  registrationMode: z.enum(["open", "invite", "closed"]),
  verifyEmail: z.enum(["on"]).optional(),
});

export const installSiteAction = defineAction({
  name: "install.site",
  auth: "guest",
  input: step2Input,
  async run(_ctx, input) {
    await requireNotInstalled();
    const registration =
      input.registrationMode === "open"
        ? { mode: "open" as const, verifyEmail: input.verifyEmail === "on" }
        : input.registrationMode === "closed"
          ? { mode: "closed" as const }
          : { mode: "invite" as const };
    const site = { name: input.name, tagline: input.tagline, url: input.url };
    const draft: InstallDraft = { site, themePack: input.themePack, registration };
    const check = validateSiteSlice(site);
    if (!check.ok) failTo("invalid-config", 2, draft, check.issues);
    if (!(INSTALL_THEME_PACKS as readonly string[]).includes(input.themePack)) {
      // 篡改请求不静默回退（审查 P2-10）：与 defineAction 的 404 哲学一致
      notFound();
    }
    const config: InstallConfig = installConfigFromEnv({
      site: check.value,
      themePack: input.themePack as InstallConfig["themePack"],
      registration,
    });
    const result = await runInstallStep("site-settings", config);
    if (!result.ok) failTo(result.code, 2, draft);
    redirect("/install?step=3");
  },
});

const step3Input = z.object({
  username: z.string(),
  email: z.string(),
  password: z.string(),
});

export const installAdminAction = defineAction({
  name: "install.admin",
  auth: "guest",
  input: step3Input,
  async run(_ctx, input) {
    await requireNotInstalled();
    const admin = { username: input.username, email: input.email, password: input.password };
    // 口令不进失败草稿（审查 P1-1/F-6：草稿会进 URL query 与 HTML value）——重填成本低，G-19 不覆盖口令
    const draft: InstallDraft = { admin: { username: admin.username, email: admin.email } };
    const check = validateAdminSlice(admin);
    if (!check.ok) failTo("invalid-config", 3, draft, check.issues);
    const config: InstallConfig = installConfigFromEnv({ admin: check.value });
    const created = await runInstallStep("admin", config);
    if (!created.ok) failTo(created.code, 3, draft);
    const lock = await runInstallStep("lock", config);
    if (!lock.ok) failTo(lock.code, 3, draft);
    // lock 落盘后 /install 全路由 404（D2）——完成提示跳到登录页，不能跳回本向导；
    // Server Action 的 redirect 走响应头，中文必须 encodeURIComponent（同 auth.ts 注册路径）
    redirect(
      "/login?message=" + encodeURIComponent("安装完成——请用管理员账号登录，创建版块后开始发帖"),
    );
  },
});
