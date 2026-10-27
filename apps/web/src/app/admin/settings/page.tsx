import { requireAdmin } from "@/lib/authz/require-admin";
import { getRegisterMode } from "@/lib/auth/settings";
import { getLimitsConfig } from "@/lib/limits/load";
import { getSiteIdentity } from "@/lib/site-chrome";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { saveIdentityAction, saveLimitsAction, saveRegisterModeAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "站点配置" };

const FLASH: Record<string, string> = {
  identity: "站点身份已保存并即时生效。",
  register: "注册策略已保存。",
  limits: "频控配置已保存。",
};

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
  searchParams: Promise<{ saved?: string; err?: string }>;
}) {
  // 入口鉴权约定：第一个 await 必须是 requireAdmin（admin-entry-guard 静态守护）
  await requireAdmin("site.admin");
  const [identity, mode, limits, sp] = await Promise.all([
    getSiteIdentity(),
    getRegisterMode(),
    getLimitsConfig(),
    searchParams,
  ]);
  const flash = sp.saved ? FLASH[sp.saved] : undefined;

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
            <SubmitButton className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
              保存身份
            </SubmitButton>
          </form>
          <p className="mt-2 text-xs text-muted-foreground">
            生效范围：顶栏与品牌卡、页面标题、邮件主题与落款；缓存最多 30 秒收敛。
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
