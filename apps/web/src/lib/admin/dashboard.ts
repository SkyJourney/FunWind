import { and, gte, sql } from "drizzle-orm";
import { getWebDb, posts, threads, users } from "@funwind/db";
import { nowBeijingWallTime } from "@/lib/datetime";

/**
 * 数据看板聚合（M9，轻量 SQL）：30 天注册/主题/回帖趋势 + 当日活跃（登录事件）。
 * 不引图表库——渲染为纯 CSS 柱状（flex + height%）。
 */

export interface DailyCount {
  date: string; // YYYY-MM-DD
  n: number;
}

/** 最近 days 天逐日计数（含今天；无数据日补 0）。table 由调用方限定（users/threads/posts） */
async function dailyCounts(
  since: string,
  table: "users" | "threads" | "posts",
): Promise<DailyCount[]> {
  const column =
    table === "users" ? users.createdAt : table === "threads" ? threads.createdAt : posts.createdAt;
  const rows = await getWebDb()
    .select({
      d: sql<string>`DATE_FORMAT(${column}, '%Y-%m-%d')`,
      n: sql<number>`COUNT(*)`,
    })
    .from(table === "users" ? users : table === "threads" ? threads : posts)
    .where(gte(column, since))
    .groupBy(sql`DATE_FORMAT(${column}, '%Y-%m-%d')`);
  const byDate = new Map(rows.map((r) => [r.d, Number(r.n)]));
  const out: DailyCount[] = [];
  const start = new Date(`${since}T00:00:00Z`).getTime();
  for (let i = 0; i < 30; i++) {
    const date = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    out.push({ date, n: byDate.get(date) ?? 0 });
  }
  return out;
}

export interface DashboardData {
  registered30: DailyCount[];
  threads30: DailyCount[];
  replies30: DailyCount[];
  todayLogins: number;
  totals: { users: number; threads: number; posts: number };
}

/** 60s 进程内缓存（M9.5）：3 个全表 COUNT + 3 个趋势聚合进页即跑，看板是站长首屏，缓存防抖 */
let dashboardCache: { at: number; value: DashboardData } | null = null;
const DASHBOARD_TTL_MS = 60_000;

export async function dashboardData(): Promise<DashboardData> {
  if (dashboardCache && Date.now() - dashboardCache.at < DASHBOARD_TTL_MS) {
    return dashboardCache.value;
  }
  const since = nowBeijingWallTime(Date.now() - 29 * 86_400_000).slice(0, 10);
  const [registered30, threads30, replies30, [logins], [u], [t], [p]] = await Promise.all([
    dailyCounts(since, "users"),
    dailyCounts(since, "threads"),
    dailyCounts(since, "posts"),
    getWebDb()
      .select({ n: sql<number>`COUNT(*)` })
      .from(sql`event_log`)
      .where(
        and(
          sql`event_name = 'user.logged_in'`,
          gte(sql`created_at`, `${nowBeijingWallTime().slice(0, 10)} 00:00:00`),
        ),
      ),
    getWebDb()
      .select({ n: sql<number>`COUNT(*)` })
      .from(users),
    getWebDb()
      .select({ n: sql<number>`COUNT(*)` })
      .from(threads),
    getWebDb()
      .select({ n: sql<number>`COUNT(*)` })
      .from(posts),
  ]);
  const value = {
    registered30,
    threads30,
    replies30,
    todayLogins: Number(logins?.n ?? 0),
    totals: { users: Number(u?.n ?? 0), threads: Number(t?.n ?? 0), posts: Number(p?.n ?? 0) },
  };
  dashboardCache = { at: Date.now(), value };
  return value;
}
