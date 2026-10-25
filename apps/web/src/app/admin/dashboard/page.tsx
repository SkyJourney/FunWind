import Link from "next/link";
import { requireAdmin } from "@/lib/authz/require-admin";
import { dashboardData, type DailyCount } from "@/lib/admin/dashboard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";
export const metadata = { title: "数据看板" };

/** 纯 CSS 柱状图（不引图表库）：30 根柱，flex + height%，相对最大值归一 */
function BarChart({ data, label }: { data: DailyCount[]; label: string }) {
  const max = Math.max(1, ...data.map((d) => d.n));
  const total = data.reduce((sum, d) => sum + d.n, 0);
  return (
    <div>
      <div
        className="flex h-24 items-end gap-[2px]"
        role="img"
        aria-label={`${label} 近 30 天柱状图，合计 ${total}`}
      >
        {data.map((d) => (
          <div
            key={d.date}
            title={`${d.date}：${d.n}`}
            className="flex-1 rounded-t-sm bg-primary/25 hover:bg-primary/50"
            style={{ height: `${Math.max(2, (d.n / max) * 100)}%` }}
          />
        ))}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {label}：30 天合计 {total}
      </p>
    </div>
  );
}

/** 数据看板（M9，admin 首页）：30 天注册/主题/回帖趋势 + 当日登录数 + 总量。轻量 SQL + CSS 柱状。 */
export default async function AdminDashboardPage() {
  await requireAdmin("admin.logs");
  const data = await dashboardData();

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>总量</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-x-8 gap-y-1 text-sm">
          <span>
            用户 <strong className="text-base">{data.totals.users}</strong>
          </span>
          <span>
            主题 <strong className="text-base">{data.totals.threads}</strong>
          </span>
          <span>
            帖子 <strong className="text-base">{data.totals.posts}</strong>
          </span>
          <span>
            今日登录 <strong className="text-base">{data.todayLogins}</strong>
          </span>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>注册趋势</CardTitle>
          </CardHeader>
          <CardContent>
            <BarChart data={data.registered30} label="注册" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>新主题趋势</CardTitle>
          </CardHeader>
          <CardContent>
            <BarChart data={data.threads30} label="新主题" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>回帖趋势</CardTitle>
          </CardHeader>
          <CardContent>
            <BarChart data={data.replies30} label="回帖" />
          </CardContent>
        </Card>
      </div>

      <p className="text-xs text-muted-foreground">
        活跃口径：当日登录事件数（event_log user.logged_in）。更多日志见
        <Link href="/admin/logs" className="ml-1 text-primary hover:underline">
          审计中心
        </Link>
        。
      </p>
    </div>
  );
}
