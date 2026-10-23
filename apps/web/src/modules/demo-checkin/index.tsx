import { and, desc, eq, gte } from "drizzle-orm";
import { eventLog, withDb } from "@funwind/db";
import { defineModule } from "../kernel/types";

/** 演示模块：事件→审计→槽位全链路验证载体（M7 由真实签到模块替换） */

const WINDOW_MS = 5 * 60 * 1000;

async function renderFooterNotice() {
  const since = new Date(Date.now() - WINDOW_MS);
  const row = await withDb(async ({ db }) => {
    const rows = await db
      .select({ createdAt: eventLog.createdAt })
      .from(eventLog)
      .where(and(eq(eventLog.eventName, "user.logged_in"), gte(eventLog.createdAt, since)))
      .orderBy(desc(eventLog.createdAt))
      .limit(1);
    return rows[0] ?? null;
  });
  if (!row) return null;
  const mins = Math.max(1, Math.round((Date.now() - new Date(row.createdAt).getTime()) / 60000));
  return (
    <div className="rounded-xl border border-cyan-200 bg-accent px-4 py-3 text-sm text-accent-foreground dark:border-cyan-900">
      🎉 <strong>demo-checkin</strong>：{mins} 分钟前有用户登录 —— 事件 → event_log → 槽位全链路打通
    </div>
  );
}

export const demoCheckin = defineModule({
  id: "demo-checkin",
  description:
    "演示模块：消费 user.logged_in（链路证明靠 event_log 审计），在 home.footer-notice 渲染最近登录横幅。M7 由真实签到模块替换。",
  events: {
    // 无副作用消费：事件本身已由总线写入 event_log 审计
    "user.logged_in": () => {},
  },
  slots: {
    "home.footer-notice": renderFooterNotice,
  },
});
