import { eq } from "drizzle-orm";
import { getWebDb, users } from "@funwind/db";
import { requireAdmin } from "@/lib/authz/require-admin";
import { getEmailVerificationMode, getRegisterMode } from "@/lib/auth/settings";
import { getDigestHour, securityEmailEnabled } from "@/lib/notifications/email";
import { getLimitsConfig } from "@/lib/limits/load";
import { getSiteIdentity } from "@/lib/site-chrome";
import { SITE_URL } from "@/lib/site";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  saveDigestHourAction,
  saveEmailSecurityAction,
  saveEmailVerificationAction,
  saveIdentityAction,
  saveLimitsAction,
  saveRegisterModeAction,
  sendTestMailAction,
} from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "站点配置" };

const FLASH: Record<string, string> = {
  identity: "站点身份已保存并即时生效。",
  register: "注册策略已保存。",
  limits: "频控配置已保存。",
  email_verification: "邮箱验证策略已保存。",
  mail_sent: "测试邮件已发出——请查收（dev 环境进 Mailpit）。",
};

const MAIL_ERROR: Record<string, string> = {
  no_email: "当前管理员账号未绑定邮箱——先到 /settings/email 绑定。",
  send: "测试邮件发送失败——请检查服务器 SMTP_URL 配置与网络。",
};

/** SMTP_URL 脱敏展示：只露协议+主机+端口，凭据不打出来 */
function smtpDisplayOf(raw: string | undefined): string {
  try {
    const u = new URL(raw ?? "smtp://127.0.0.1:1025");
    return `${u.protocol.replace(":", "")}://${u.hostname}${u.port ? `:${u.port}` : ""}`;
  } catch {
    return "（SMTP_URL 配置无效）";
  }
}

const inputCls =
  "rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring";
const numCls = `${inputCls} w-28`;

/** 频控角色字段组（秒/次数含义见 lib/limits/config.ts；0 = 不限） */
const ROLE_FIELDS = [
  ["postIntervalSec", "发帖间隔（秒）", 3600],
  ["threadsPerDay", "每日主题数", 100_000],
  ["uploadsPerDay", "每日上传数", 100_000],
  ["pmPerDay", "每日私信数", 100_000],
  ["editWindowSec", "可编辑时限（秒）", 31_536_000],
] as const;

/**
 * 站点配置（M10.6b）：身份（site.identity）/注册模式（register.mode）/频控（limits）。
 * 写入全走 setSetting（自带审计）；全站默认主题键位留 M11 随主题选择落地。
 */
export default async function SiteSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; err?: string; mail_error?: string }>;
}) {
  // 入口鉴权约定：第一个 await 必须是 requireAdmin（admin-entry-guard 静态守护）
  const admin = await requireAdmin("site.admin");
  const [identity, mode, limits, verificationMode, securityMail, digestHour, adminRow, sp] =
    await Promise.all([
      getSiteIdentity(),
      getRegisterMode(),
      getLimitsConfig(),
      getEmailVerificationMode(),
      securityEmailEnabled(),
      getDigestHour(),
      getWebDb()
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, admin.userId))
        .limit(1),
      searchParams,
    ]);
  const adminEmail = adminRow[0]?.email ?? null;
  const flash = sp.saved ? FLASH[sp.saved] : undefined;
  const mailError = sp.mail_error ? MAIL_ERROR[sp.mail_error] : undefined;
  const smtpDisplay = smtpDisplayOf(process.env.SMTP_URL);
  const mailFrom = process.env.MAIL_FROM ?? "青翼字幕组 <noreply@qingyisub.top>";

  return (
    <div className="space-y-5">
      <header>
        <h2 className="text-lg font-bold tracking-tight">站点配置</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          站点身份、注册策略与发帖频控；全部修改写入审计日志。全站默认主题将在 M11 随主题选择提供。
        </p>
      </header>

      {flash && (
        <p className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
          {flash}
        </p>
      )}
      {mailError && (
        <p
          role="alert"
          className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning"
        >
          {mailError}
        </p>
      )}
      {sp.err === "limits" && (
        <p
          role="alert"
          className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning"
        >
          频控配置校验未通过（每个角色项必须写全且不超上限），请检查后重试。
        </p>
      )}

      {/* 身份 */}
      <Card>
        <CardHeader>
          <CardTitle>站点身份</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={saveIdentityAction} className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-sm">
              站点名称
              <input
                name="name"
                required
                maxLength={40}
                defaultValue={identity.name}
                className={`${inputCls} w-56`}
              />
            </label>
            <label className="grid gap-1 text-sm">
              副标题 / 描述（留空恢复默认）
              <input
                name="tagline"
                maxLength={80}
                defaultValue={identity.tagline}
                className={`${inputCls} w-80`}
              />
            </label>
            <label className="grid gap-1 text-sm">
              站点访问地址（留空用环境默认）
              <input
                name="url"
                type="url"
                pattern="https?://.*"
                title="须以 http:// 或 https:// 开头"
                placeholder={SITE_URL}
                defaultValue={identity.url === SITE_URL ? "" : identity.url}
                className={`${inputCls} w-72`}
              />
            </label>
            <SubmitButton className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
              保存身份
            </SubmitButton>
          </form>
          <p className="mt-2 text-xs text-muted-foreground">
            生效范围：顶栏与品牌卡、页面标题、邮件主题与落款、邮件里的链接地址、sitemap；缓存最多 30
            秒收敛。 访问地址只影响对外链接——Cookie 安全属性等部署拓扑始终由服务器环境变量决定。
          </p>
        </CardContent>
      </Card>

      {/* 注册 */}
      <Card>
        <CardHeader>
          <CardTitle>注册策略</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={saveRegisterModeAction} className="space-y-2 text-sm">
            <label className="flex items-start gap-2">
              <input
                type="radio"
                name="mode"
                value="invite"
                defaultChecked={mode === "invite"}
                className="mt-1 size-4"
              />
              <span>
                <span className="font-medium">邀请制</span>
                <span className="text-muted-foreground">
                  ——注册需持有效邀请码（当前可在「邀请码」页签发）
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input
                type="radio"
                name="mode"
                value="open"
                defaultChecked={mode === "open"}
                className="mt-1 size-4"
              />
              <span>
                <span className="font-medium">开放注册</span>
                <span className="text-muted-foreground">
                  ——凭邮箱注册，注册后需完成邮箱验证（未验证不开放写权限）
                </span>
              </span>
            </label>
            <div>
              <SubmitButton className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
                保存注册策略
              </SubmitButton>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* 邮件（M10.6 收尾）：SMTP 凭据留在 env；后台做状态展示、测试发信与验证策略 */}
      <Card>
        <CardHeader>
          <CardTitle>邮件</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <dl className="grid gap-x-6 gap-y-1 text-muted-foreground sm:grid-cols-[auto_1fr]">
            <dt className="font-medium text-foreground">SMTP 服务</dt>
            <dd>
              <code className="rounded bg-muted px-1 text-xs">{smtpDisplay}</code>
              <span className="ml-1 text-xs">（由服务器环境变量 SMTP_URL 配置，凭据不入库）</span>
            </dd>
            <dt className="font-medium text-foreground">发件人</dt>
            <dd>
              <code className="rounded bg-muted px-1 text-xs">{mailFrom}</code>
            </dd>
            <dt className="font-medium text-foreground">站点链接</dt>
            <dd>
              <code className="rounded bg-muted px-1 text-xs">{identity.url}</code>
              <span className="ml-1 text-xs">
                （{identity.url === SITE_URL ? "环境默认 APP_URL" : "后台配置"}
                ，邮件里的链接指向它）
              </span>
            </dd>
          </dl>

          <form action={sendTestMailAction}>
            <SubmitButton className="rounded-lg border px-3 py-1.5 hover:bg-accent disabled:opacity-60">
              发送测试邮件（发到我的邮箱：{adminEmail ?? "未绑定"}）
            </SubmitButton>
          </form>

          <form action={saveEmailVerificationAction} className="space-y-2 border-t pt-4">
            <p className="font-medium">邮箱验证策略</p>
            <label className="flex items-start gap-2">
              <input
                type="radio"
                name="mode"
                value="open_only"
                defaultChecked={verificationMode === "open_only"}
                className="mt-1 size-4"
              />
              <span>
                <span className="font-medium">仅开放注册验证（默认）</span>
                <span className="text-muted-foreground">
                  ——开放注册强制验证；邀请制注册凭邀请码即算可信，不发验证邮件
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input
                type="radio"
                name="mode"
                value="always"
                defaultChecked={verificationMode === "always"}
                className="mt-1 size-4"
              />
              <span>
                <span className="font-medium">一律验证</span>
                <span className="text-muted-foreground">
                  ——邀请注册同样发验证邮件（邮箱可用的账号更可靠，召回不失效）
                </span>
              </span>
            </label>
            <div>
              <SubmitButton className="rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
                保存验证策略
              </SubmitButton>
            </div>
          </form>

          <form action={saveEmailSecurityAction} className="space-y-2 border-t pt-4">
            <p className="font-medium">安全类邮件通知（密码修改 / 邮箱换绑 / 账号限制）</p>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                name="enabled"
                value="on"
                defaultChecked={securityMail}
                className="mt-1 size-4"
              />
              <span className="text-muted-foreground">
                由站点统一控制发送，用户不可逐项关闭（处罚送达与防盗号知情是平台义务）。
              </span>
            </label>
            <div>
              <SubmitButton className="rounded-lg border px-3 py-1.5 hover:bg-accent disabled:opacity-60">
                保存安全通知开关
              </SubmitButton>
            </div>
          </form>

          <form action={saveDigestHourAction} className="space-y-2 border-t pt-4">
            <p className="font-medium">每日汇总发送时刻</p>
            <div className="flex items-end gap-3">
              <label className="grid gap-1">
                发送时刻（0–23 点）
                <input
                  name="hour"
                  type="number"
                  min={0}
                  max={23}
                  defaultValue={digestHour}
                  className={numCls}
                />
              </label>
              <SubmitButton className="rounded-lg border px-3 py-1.5 hover:bg-accent disabled:opacity-60">
                保存时刻
              </SubmitButton>
            </div>
            <p className="text-xs text-muted-foreground">
              系统定时任务每小时运行比对；仅发给在「通知偏好」开启邮件汇总、且 24
              小时内未登录的用户。服务器侧需配置 crontab 每小时整点运行 digest-cron 脚本。
            </p>
          </form>
        </CardContent>
      </Card>

      {/* 频控 */}
      <Card>
        <CardHeader>
          <CardTitle>发帖频控</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={saveLimitsAction} className="space-y-4 text-sm">
            <div className="flex flex-wrap gap-3">
              <label className="grid gap-1">
                标题最大字符数
                <input
                  name="titleMax"
                  type="number"
                  min={1}
                  max={255}
                  defaultValue={limits.titleMax}
                  className={numCls}
                />
              </label>
              <label className="grid gap-1">
                正文最大字符数
                <input
                  name="bodyMax"
                  type="number"
                  min={1}
                  max={1000000}
                  defaultValue={limits.bodyMax}
                  className={numCls}
                />
              </label>
            </div>
            {(["member", "admin"] as const).map((role) => (
              <fieldset key={role} className="rounded-lg border p-3">
                <legend className="px-1 text-xs font-medium text-muted-foreground">
                  {role === "member" ? "普通会员（member）" : "管理员（admin）"}
                </legend>
                <div className="flex flex-wrap gap-3">
                  {ROLE_FIELDS.map(([field, label]) => (
                    <label key={field} className="grid gap-1">
                      {label}
                      <input
                        name={`${role}${field[0].toUpperCase()}${field.slice(1)}`}
                        type="number"
                        min={0}
                        defaultValue={limits.roles[role]?.[field] ?? 0}
                        className={numCls}
                      />
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}
            <p className="text-xs text-muted-foreground">
              0 = 不限。仅展示 member / admin 两个内置角色；其他角色的现有配置保存时原样保留。
            </p>
            <div>
              <SubmitButton className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
                保存频控
              </SubmitButton>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
