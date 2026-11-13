"use server";

import { defineAction } from "@/lib/actions/define-action";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { setSetting } from "@/lib/auth/settings";
import { getLimitsConfig } from "@/lib/limits/load";
import { limitsConfigSchema } from "@/lib/limits/config";
import { invalidateSiteChrome } from "@/lib/chrome/site-chrome";
import { getCurrentUser } from "@/lib/auth/session";
import { eq } from "drizzle-orm";
import { getWebDb, users as usersTable } from "@funwind/db";
import { getMailBrand, sendMail, testMail } from "@/lib/mail";
import { setSiteDefaultThemePack } from "@/lib/theme/packs";
import { tryApplyThemePackLogo } from "@/lib/theme/apply-pack-logo";

/**
 * 站点配置动作（M10.6b，docs/milestones/M10.6-feature-completion.md 批次 b）：
 * 身份/注册模式/频控三组。写入全走 setSetting（自带前后值审计）；身份保存失效 chrome 缓存。
 * 频控编辑器只 merge 它认识的字段（member/admin 两角色 + 站点级两项），其余角色原值保留，
 * 保存前整体过 limitsConfigSchema 校验——写坏配置会整体回落默认值（load.ts 口径），必须在这里拦住。
 * 邮件组（M10.6 收尾）：SMTP 凭据按红线留在 env 不入库，后台只做状态展示与测试发信；注册与邮箱验证要求并入 register.policy（M11.3）。
 * 全站默认主题（M11）：site.theme + 主题↔LOGO 联动（docs/THEME-SYSTEM.md §5）。
 */

const done = (key: string): never => redirect(`/admin/settings?saved=${key}`);

/**
 * 全站默认主题包：保存后触发联动——有自带 LOGO 的包自动入池并设为当前（幂等），无图不触碰 LOGO 池；
 * 素材缺失等只影响联动结果（flash 文案区分），不阻断主题保存本身。
 */
export const saveThemePackAction = defineAction({
  name: "admin.settings.theme",
  auth: { admin: "site.admin" },
  input: z.object({ pack: z.string().max(32) }),
  async run(ctx, input) {
    const actor = ctx.actor;
    const result = await setSiteDefaultThemePack(input.pack, actor);
    if (!result.ok) redirect("/admin/settings?err=theme");
    const logo = await tryApplyThemePackLogo(input.pack, { ...actor, via: "theme" });
    invalidateSiteChrome();
    revalidatePath("/admin/themes");
    revalidatePath("/", "layout");
    const saved =
      logo.status === "applied"
        ? "theme_logo"
        : logo.status === "unchanged"
          ? "theme_no_logo"
          : "theme";
    redirect(`/admin/settings?saved=${saved}${logo.status === "failed" ? "&warn=logo" : ""}`);
  },
});

export const saveIdentityAction = defineAction({
  name: "admin.settings.identity",
  auth: { admin: "site.admin" },
  input: z.object({
    name: z.string().trim().min(1, "站点名不能为空").max(40),
    tagline: z.string().trim().max(80).default(""),
    /** 对外访问地址：空 = 用环境默认（APP_URL）；填了须 http(s):// 开头（邮件链接/sitemap 用） */
    url: z
      .string()
      .trim()
      .max(200)
      .default("")
      .refine((v) => v === "" || /^https?:\/\/.+/.test(v.replace(/\/+$/, "")), {
        message: "访问地址需以 http(s):// 开头",
      }),
  }),
  async run(ctx, input) {
    await setSetting(
      "site.identity",
      {
        name: input.name,
        tagline: input.tagline,
        url: input.url === "" ? "" : input.url.replace(/\/+$/, ""),
      },
      ctx.actor,
    );
    invalidateSiteChrome();
    revalidatePath("/", "layout");
    done("identity");
  },
});

/**
 * 注册策略（M11.3）：开放注册 / 邀请注册两个独立开关 + 「开放注册需验证邮箱」。
 * 复选框未勾选时表单不提交该字段，所以用 `value="on"` 的可选枚举表示勾选。
 * 取代原 saveRegisterModeAction（单选）与 saveEmailVerificationAction（open_only/always）：
 * 写入新键 register.policy 后旧的 register.mode 不再参与判定（读兼容见 lib/auth/register-policy）。
 * 两个开关都关是合法状态（访客看到「当前不开放注册」），保存时给专门提示，避免误操作无声发生。
 */
const checked = z.enum(["on"]).optional();

export const saveRegisterPolicyAction = defineAction({
  name: "admin.settings.register",
  auth: { admin: "site.admin" },
  input: z.object({ open: checked, invite: checked, verifyEmail: checked }),
  async run(ctx, input) {
    const policy = {
      open: input.open === "on",
      invite: input.invite === "on",
      verifyEmail: input.verifyEmail === "on",
    };
    await setSetting("register.policy", policy, ctx.actor);
    // 顶栏「注册」入口读 site chrome 缓存里的 registrationOpen：不失效的话保存后最多 30 秒仍显示旧状态
    invalidateSiteChrome();
    revalidatePath("/admin/settings");
    revalidatePath("/register");
    revalidatePath("/", "layout");
    done(!policy.open && !policy.invite ? "register_closed" : "register");
  },
});

const nonNeg = (max: number) => z.coerce.number().int().min(0).max(max);

export const saveLimitsAction = defineAction({
  name: "admin.settings.limits",
  auth: { admin: "site.admin" },
  input: z.object({
    titleMax: z.coerce.number().int().min(1).max(255),
    bodyMax: z.coerce.number().int().min(1).max(1_000_000),
    // 只暴露 member / admin 两个内置角色（DEFAULT_LIMITS 的角色集）；其他角色由 merge 保留
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
  }),
  async run(ctx, input) {
    const current = await getLimitsConfig();
    const merged = limitsConfigSchema.safeParse({
      titleMax: input.titleMax,
      bodyMax: input.bodyMax,
      roles: {
        ...current.roles,
        member: {
          postIntervalSec: input.memberPostIntervalSec,
          threadsPerDay: input.memberThreadsPerDay,
          uploadsPerDay: input.memberUploadsPerDay,
          pmPerDay: input.memberPmPerDay,
          editWindowSec: input.memberEditWindowSec,
        },
        admin: {
          postIntervalSec: input.adminPostIntervalSec,
          threadsPerDay: input.adminThreadsPerDay,
          uploadsPerDay: input.adminUploadsPerDay,
          pmPerDay: input.adminPmPerDay,
          editWindowSec: input.adminEditWindowSec,
        },
      },
    });
    if (!merged.success) redirect("/admin/settings?err=limits");
    await setSetting("limits", merged.data, ctx.actor);
    revalidatePath("/admin/settings");
    done("limits");
  },
});

/** S1–S3 安全强制类邮件的后台统一开关（用户侧不可关；docs/EMAIL-SCENARIOS.md 站长裁决）。
 * checkbox 未勾选时参数缺席——用字符串缺省解析，不能用 enum（safeParse 失败→404，开关永远关不掉）。 */
export const saveEmailSecurityAction = defineAction({
  name: "admin.settings.email_security",
  auth: { admin: "site.admin" },
  input: z.object({ enabled: z.string().default("") }),
  async run(ctx, input) {
    await setSetting("email.security", { enabled: input.enabled === "on" }, ctx.actor);
    revalidatePath("/admin/settings");
    done("email_security");
  },
});

/**
 * 运维告警邮件的后台统一开关（M17 Step 2）：管线任务失败时除站内通知外再发邮件给管理员。
 * 与安全类同款——站点统一控制、用户侧不可逐项关闭（`ops.run.failed` 是 mandatory 类型）。
 * 默认开；checkbox 未勾选时参数缺席，同样用字符串缺省解析（不能用 enum，否则永远关不掉）。
 */
export const saveEmailOpsAction = defineAction({
  name: "admin.settings.email_ops",
  auth: { admin: "site.admin" },
  input: z.object({ enabled: z.string().default("") }),
  async run(ctx, input) {
    await setSetting("email.ops", { enabled: input.enabled === "on" }, ctx.actor);
    revalidatePath("/admin/settings");
    done("email_ops");
  },
});

/** S7 每日汇总的发送时刻（0–23 点；系统 cron 每小时调 digest-cron 脚本比对空转） */
export const saveDigestHourAction = defineAction({
  name: "admin.settings.digest_hour",
  auth: { admin: "site.admin" },
  input: z.object({ hour: z.coerce.number().int().min(0).max(23) }),
  async run(ctx, input) {
    await setSetting("email.digest", { hour: input.hour }, ctx.actor);
    revalidatePath("/admin/settings");
    done("digest_hour");
  },
});

export const sendTestMailAction = defineAction({
  name: "admin.settings.test_mail",
  auth: { admin: "site.admin" },
  input: z.object({}),
  async run(ctx) {
    const user = await getCurrentUser();
    if (!user) redirect("/login");
    const [row] = await getWebDb()
      .select({ email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.id, ctx.userId!))
      .limit(1);
    if (!row?.email) {
      redirect("/admin/settings?mail_error=no_email");
    }
    const brand = await getMailBrand();
    try {
      await sendMail(row.email, testMail(brand), { userId: ctx.userId });
    } catch {
      redirect("/admin/settings?mail_error=send");
    }
    revalidatePath("/admin/settings");
    done("mail_sent");
  },
});
