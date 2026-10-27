import { eq } from "drizzle-orm";
import { getWebDb, notificationPreferences } from "@funwind/db";
import { getCurrentUser } from "@/lib/auth/session";
import { NOTIF_PREF_TYPES } from "@/lib/notifications/pref-types";
import { SubmitButton } from "@/components/ui/submit-button";
import { toggleNotifPrefAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "通知偏好" };

/** 通知偏好（M10.6c）：站内渠道开关；无记录 = 开启（notify.inAppEnabled 口径）。 */
export default async function NotificationSettingsPage() {
  const user = await getCurrentUser();
  if (!user) return null;
  const rows = await getWebDb()
    .select({ type: notificationPreferences.type, enabled: notificationPreferences.enabled })
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, user.id));
  const enabledByType = new Map(rows.map((r) => [r.type, r.enabled]));

  return (
    <div className="space-y-3">
      <p className="rounded-lg border bg-card px-3 py-2 text-xs text-muted-foreground">
        站内通知（顶栏铃铛）按事件类型开关；关闭后新事件不再写入你的通知列表。审核与账户安全类通知不受影响。
      </p>
      {NOTIF_PREF_TYPES.map((t) => {
        const enabled = enabledByType.get(t.type) ?? true;
        return (
          <div
            key={t.type}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border bg-card px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{t.label}</p>
              <p className="text-xs text-muted-foreground">{t.description}</p>
            </div>
            <form action={toggleNotifPrefAction}>
              <input type="hidden" name="type" value={t.type} />
              <input type="hidden" name="enabled" value={enabled ? "off" : "on"} />
              <SubmitButton
                className={`rounded-lg border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-60 ${
                  enabled ? "text-success" : "text-muted-foreground"
                }`}
                pendingText="…"
              >
                {enabled ? "已开启 · 点击关闭" : "已关闭 · 点击开启"}
              </SubmitButton>
            </form>
          </div>
        );
      })}
    </div>
  );
}
