import Link from "next/link";
import { requireAdmin } from "@/lib/authz/require-admin";
import { dashboardData, type DailyCount } from "@/lib/admin/dashboard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";
export const metadata = { title: "数据看板" };

/** 纯 CSS 柱状图（不引图表库）：30 根柱，flex + height%，相对最大值归一。峰值/日均标注 + sr-only 数据表（M9.5） */
function BarChart({ data, label }: { data: DailyCount[]; label: string }) {
  const max = Math.max(1, ...data.map((d) => d.n));
  const total = data.reduce((sum, d) => sum + d.n, 0);
  const peak = data.reduce((a, b) => (b.n > a.n ? b : a), data[0] ?? { date: "—", n: 0 });
  const avg = Math.round((total / 30) * 10) / 10;
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
        {label}：30 天合计 {total} · 峰值 {peak.n}（{peak.date.slice(5)}） · 日均 {avg}
      </p>
      {/* 单日数据对读屏/移动端 hover 不可达：sr-only 表兜底（M9.5） */}
      <table className="sr-only">
        <caption>{label}近 30 天逐日数量</caption>
        <thead>
          <tr>
            <th scope="col">日期</th>
            <th scope="col">数量</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.date}>
              <td>{d.date}</td>
              <td>{d.n}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 半月对比小标（趋势方向直读）：近 15 天合计 vs 前 15 天合计 */
function HalfTrend({ first, second, label }: { first: number; second: number; label: string }) {
  if (first === second)
    return <span className="ml-1 text-xs text-muted-foreground">近半月与上半月持平</span>;
  const up = second > first;
  return (
    <span className={`ml-1 text-xs ${up ? "text-success" : "text-destructive"}`}>
      {up ? "↑" : "↓"} 近半月 {second} vs 前半月 {first}（{label}）
    </span>
  );
}

/** 数据看板（M9；M9.5 增补峰值/日均标注、半月对比、sr-only 数据表、60s 缓存）。 */
export default async function AdminDashboardPage() {
  await requireAdmin("admin.logs");
  const data = await dashboardData();
  const halfTrend = (arr: DailyCount[]) => {
    const first = arr.slice(0, 15).reduce((s, d) => s + d.n, 0);
    const second = arr.slice(15).reduce((s, d) => s + d.n, 0);
    return { first, second };
  };
  const reg = halfTrend(data.registered30);
  const thr = halfTrend(data.threads30);
  const rep = halfTrend(data.replies30);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>总量</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-x-8 gap-y-1 text-sm">
          <span>
            用户 <strong className="text-base">{data.totals.users}</strong>
            <HalfTrend {...reg} label="注册" />
          </span>
          <span>
            主题 <strong className="text-base">{data.totals.threads}</strong>
            <HalfTrend {...thr} label="发题" />
          </span>
          <span>
            帖子 <strong className="text-base">{data.totals.posts}</strong>
            <HalfTrend {...rep} label="回帖" />
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
        活跃口径：当日登录事件数（event_log user.logged_in）。统计缓存 60 秒。更多日志见
        <Link href="/admin/logs" className="ml-1 text-primary hover:underline">
          审计中心
        </Link>
        。
      </p>
    </div>
  );
}
