import { and, desc, eq, gte } from "drizzle-orm";
import { eventLog, getWebDb } from "@funwind/db";
import { nowBeijingWallTime, parseDbDateTime } from "@/lib/datetime";
import { defineModule } from "../kernel/types";

/** 演示模块：事件→审计→槽位全链路验证载体（M7 由真实签到模块替换） */

const WINDOW_MS = 5 * 60 * 1000;

async function renderFooterNotice() {
  // 字符串模式下 DATETIME 比较即墙面时间字典序（定长格式，时序安全）
  const since = nowBeijingWallTime(Date.now() - WINDOW_MS);
  const db = getWebDb();
  const rows = await db
    .select({ createdAt: eventLog.createdAt })
    .from(eventLog)
    .where(and(eq(eventLog.eventName, "user.logged_in"), gte(eventLog.createdAt, since)))
    .orderBy(desc(eventLog.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  // createdAt 为北京墙面时间字符串：必须经 parseDbDateTime 显式 +08:00 解析（禁止裸 new Date）
  const mins = Math.max(
    1,
    Math.round((Date.now() - parseDbDateTime(row.createdAt).getTime()) / 60000),
  );
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
