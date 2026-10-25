import { and, desc, eq, gte } from "drizzle-orm";
import { eventLog, getWebDb } from "@funwind/db";
import { nowBeijingWallTime, parseDbDateTime } from "@/lib/datetime";
import { defineModule } from "../kernel/types";

/** 演示模块：事件→审计→槽位全链路验证载体（M7 由真实签到模块替换） */

const WINDOW_MS = 5 * 60 * 1000;

/**
 * 业务事件的演示计数（M6.5c）：消费方收到真实事件就 +1。进程内、重启清零，只为证明「事件 → 消费方」链路通畅，
 * 不改变任何业务数据。挂在 globalThis 上，避免开发模式热更新后计数被重置成两份。
 */
const g = globalThis as unknown as { __fwDemoBusinessEvents?: Map<string, number> };
function bumpBusiness(name: string): void {
  const m = (g.__fwDemoBusinessEvents ??= new Map());
  m.set(name, (m.get(name) ?? 0) + 1);
}
export function demoBusinessCounts(): Record<string, number> {
  return Object.fromEntries(g.__fwDemoBusinessEvents ?? []);
}

function businessLine(): string | null {
  const counts = demoBusinessCounts();
  const parts = ["thread.created", "thread.replied", "attachment.uploaded"]
    .filter((k) => (counts[k] ?? 0) > 0)
    .map((k) => `${k} × ${counts[k]}`);
  return parts.length > 0 ? `业务事件（演示，进程内计数）：${parts.join(" · ")}` : null;
}

async function renderFooterNotice() {
  const business = businessLine();
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
  if (!row)
    return business ? (
      <div className="px-4 py-2 text-xs text-muted-foreground">{business}</div>
    ) : null;
  // createdAt 为北京墙面时间字符串：必须经 parseDbDateTime 显式 +08:00 解析（禁止裸 new Date）
  const mins = Math.max(
    1,
    Math.round((Date.now() - parseDbDateTime(row.createdAt).getTime()) / 60000),
  );
  return (
    <>
      <div className="rounded-xl border border-cyan-200 bg-accent px-4 py-3 text-sm text-accent-foreground dark:border-cyan-900">
        🎉 <strong>demo-checkin</strong>：{mins} 分钟前有用户登录 —— 事件 → event_log →
        槽位全链路打通
      </div>
      {business && <div className="px-4 py-2 text-xs text-muted-foreground">{business}</div>}
    </>
  );
}

export const demoCheckin = defineModule({
  id: "demo-checkin",
  description:
    "演示模块：消费 user.logged_in（链路证明靠 event_log 审计）与业务事件 thread.created / thread.replied / attachment.uploaded（进程内计数），在 home.footer-notice 渲染。M7 由真实签到模块替换。",
  events: {
    // 无副作用消费：事件本身已由总线写入 event_log 审计
    "user.logged_in": () => {},
    // 业务事件（M6.5c）：真实派发的事件到达这里即计数，用于验收「demo 消费方收到真实事件」
    "thread.created": () => bumpBusiness("thread.created"),
    "thread.replied": () => bumpBusiness("thread.replied"),
    "attachment.uploaded": () => bumpBusiness("attachment.uploaded"),
  },
  slots: {
    "home.footer-notice": renderFooterNotice,
  },
});
