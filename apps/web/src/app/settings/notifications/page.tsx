import { eq } from "drizzle-orm";
import { getWebDb, notificationPreferences } from "@funwind/db";
import { getCurrentUser } from "@/lib/auth/session";
import { NOTIF_PREF_TYPES } from "@/lib/notifications/pref-types";
import { SubmitButton } from "@/components/ui/submit-button";
import { toggleNotifPrefAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "通知偏好" };

/** 通知偏好（M10.6 收尾）：站内 + 邮件双渠道开关；无记录 = 站内开、邮件关（数据模型既定口径）。 */
export default async function NotificationSettingsPage() {
  const user = await getCurrentUser();
  if (!user) return null;
  const rows = await getWebDb()
    .select({
      type: notificationPreferences.type,
      channel: notificationPreferences.channel,
      enabled: notificationPreferences.enabled,
    })
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, user.id));
  const state = new Map(rows.map((r) => [`${r.channel}:${r.type}`, r.enabled]));
  const inApp = (type: string) => state.get(`in_app:${type}`) ?? true;
  const email = (type: string) => state.get(`email:${type}`) ?? false;

  return (
    <div className="space-y-3">
      <p className="rounded-lg border bg-card px-3 py-2 text-xs text-muted-foreground">
        站内通知（顶栏铃铛）默认开启；邮件通知默认关闭、按场景逐个开启。审核与账户安全类通知不受影响
        （安全强制类邮件由站点统一控制，见后台「站点配置→邮件」）。
      </p>
      <div className="hidden items-center gap-2 px-4 text-xs text-muted-foreground sm:flex">
        <span className="flex-1">场景</span>
        <span className="w-32 text-center">站内</span>
        <span className="w-32 text-center">邮件</span>
      </div>
      {NOTIF_PREF_TYPES.map((t) => (
        <div
          key={t.type}
          className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-card px-4 py-3"
        >
          <div className="min-w-0 flex-1 basis-40">
            <p className="text-sm font-medium">{t.label}</p>
            <p className="text-xs text-muted-foreground">{t.description}</p>
          </div>
          <form action={toggleNotifPrefAction} className="w-32">
            <input type="hidden" name="type" value={t.type} />
            <input type="hidden" name="channel" value="in_app" />
            <input type="hidden" name="enabled" value={inApp(t.type) ? "off" : "on"} />
            <SubmitButton
              className={`w-full rounded-lg border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-60 ${
                inApp(t.type) ? "text-success" : "text-muted-foreground"
              }`}
              pendingText="…"
            >
              {inApp(t.type) ? "已开启" : "已关闭"}
            </SubmitButton>
          </form>
          <form action={toggleNotifPrefAction} className="w-32">
            <input type="hidden" name="type" value={t.type} />
            <input type="hidden" name="channel" value="email" />
            <input type="hidden" name="enabled" value={email(t.type) ? "off" : "on"} />
            <SubmitButton
              className={`w-full rounded-lg border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-60 ${
                email(t.type) ? "text-success" : "text-muted-foreground"
              }`}
              pendingText="…"
            >
              {email(t.type) ? "已开启" : "已关闭"}
            </SubmitButton>
          </form>
        </div>
      ))}
      {/* S7 每日汇总（email 渠道专属；发送时刻由后台配置） */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-card px-4 py-3">
        <div className="min-w-0 flex-1 basis-40">
          <p className="text-sm font-medium">每日动态汇总邮件</p>
          <p className="text-xs text-muted-foreground">
            每天一封摘要（未读私信 / 新回复 / 提及 / 新关注者）；24
            小时内登录过的日子不会发送。发送时刻由站点配置。
          </p>
        </div>
        <form action={toggleNotifPrefAction} className="w-32">
          <input type="hidden" name="type" value="email.digest" />
          <input type="hidden" name="channel" value="email" />
          <input type="hidden" name="enabled" value={email("email.digest") ? "off" : "on"} />
          <SubmitButton
            className={`w-full rounded-lg border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-60 ${
              email("email.digest") ? "text-success" : "text-muted-foreground"
            }`}
            pendingText="…"
          >
            {email("email.digest") ? "已开启" : "已关闭"}
          </SubmitButton>
        </form>
      </div>
    </div>
  );
}
