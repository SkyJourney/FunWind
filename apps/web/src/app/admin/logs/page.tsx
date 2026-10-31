import Link from "next/link";
import { requireAdmin } from "@/lib/authz/require-admin";
import { queryAuditLogs, queryEventLogs } from "@/lib/admin/logs";
import { pageBounds } from "@/lib/queries/paging";
import { JsonViewerButton } from "@/components/admin/json-viewer";
import { Pagination } from "@/components/content/pagination";

export const dynamic = "force-dynamic";
export const metadata = { title: "审计日志" };

type Params = {
  searchParams: Promise<{ tab?: string; action?: string; actor?: string; page?: string }>;
};

const PER_PAGE = 50;

/** 审计日志中心（M9，admin.logs）：audit_log + event_log 双 tab，action/actor 筛选 + 分页 + CSV 导出。 */
export default async function AdminLogsPage({ searchParams }: Params) {
  await requireAdmin("admin.logs");
  const sp = await searchParams;
  const tab = sp.tab === "events" ? "events" : "audit";
  const action = typeof sp.action === "string" && sp.action ? sp.action : undefined;
  const actorId = Number(sp.actor ?? "0") || undefined;
  const page = Number(sp.page ?? "1") || 1;
  const filter = { action, actorId, limit: PER_PAGE, page };

  const result = tab === "events" ? await queryEventLogs(filter) : await queryAuditLogs(filter);
  const { page: safePage, totalPages } = pageBounds(result.total, page, PER_PAGE);

  const baseQuery = (over: Record<string, string | number>) => {
    const p = new URLSearchParams();
    p.set("tab", tab);
    if (action) p.set("action", action);
    if (actorId) p.set("actor", String(actorId));
    for (const [k, v] of Object.entries(over)) p.set(k, String(v));
    return `/admin/logs?${p.toString()}`;
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <nav className="flex gap-2 text-sm" aria-label="日志类型">
          <Link
            href="/admin/logs"
            className={`rounded-full border px-3 py-1 ${tab === "audit" ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
          >
            审计日志
          </Link>
          <Link
            href="/admin/logs?tab=events"
            className={`rounded-full border px-3 py-1 ${tab === "events" ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
          >
            事件日志
          </Link>
        </nav>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <form
            action="/admin/logs"
            method="get"
            className="flex min-w-0 flex-wrap items-center gap-1.5"
          >
            <input type="hidden" name="tab" value={tab} />
            <input
              name="action"
              defaultValue={action ?? ""}
              placeholder={
                tab === "events" ? "事件名（如 thread.created）" : "动作（如 points.adjust）"
              }
              className="w-40 min-w-0 rounded-lg border bg-background px-2.5 py-1.5 text-xs sm:w-56"
            />
            <input
              name="actor"
              defaultValue={actorId ?? ""}
              placeholder="actor uid"
              className="w-20 min-w-0 rounded-lg border bg-background px-2.5 py-1.5 text-xs sm:w-24"
            />
            <button type="submit" className="rounded-lg border px-3 py-1.5 text-xs hover:bg-accent">
              筛选
            </button>
          </form>
          <Link
            href={`/api/admin/logs/csv?tab=${tab}${action ? `&action=${encodeURIComponent(action)}` : ""}${actorId ? `&actor=${actorId}` : ""}`}
            className="text-xs text-primary hover:underline"
            prefetch={false}
          >
            导出 CSV
          </Link>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        共 {result.total} 条 · 第 {safePage}/{totalPages} 页
      </p>
      <Pagination basePath={baseQuery({ page: "" })} page={safePage} totalPages={totalPages} />

      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full text-left text-xs">
          <thead className="border-b text-muted-foreground">
            <tr>
              <th className="px-3 py-2">id</th>
              <th className="px-3 py-2">时间</th>
              <th className="px-3 py-2">{tab === "events" ? "事件名" : "动作"}</th>
              <th className="px-3 py-2">actor</th>
              {tab === "audit" ? (
                <>
                  <th className="hidden px-3 py-2 md:table-cell">目标</th>
                  <th className="hidden px-3 py-2 sm:table-cell">详情</th>
                </>
              ) : (
                <th className="px-3 py-2">source / 错误</th>
              )}
            </tr>
          </thead>
          <tbody>
            {tab === "audit"
              ? (result as Awaited<ReturnType<typeof queryAuditLogs>>).items.map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="px-3 py-1.5 tabular-nums">{r.id}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap">{r.createdAt}</td>
                    <td className="px-3 py-1.5 font-mono">{r.action}</td>
                    <td className="px-3 py-1.5 tabular-nums">{r.actorId ?? "—"}</td>
                    <td className="hidden px-3 py-1.5 md:table-cell">
                      {r.targetType}:{r.targetId}
                    </td>
                    <td className="hidden px-3 py-1.5 sm:table-cell">
                      <JsonViewerButton label="查看" json={r.afterJson ?? r.beforeJson ?? {}} />
                    </td>
                  </tr>
                ))
              : (result as Awaited<ReturnType<typeof queryEventLogs>>).items.map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="px-3 py-1.5 tabular-nums">{r.id}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap">{r.createdAt}</td>
                    <td className="px-3 py-1.5 font-mono">{r.eventName}</td>
                    <td className="px-3 py-1.5 tabular-nums">{r.actorId ?? "—"}</td>
                    <td className="px-3 py-1.5">
                      {r.source ?? "—"}
                      {r.errorJson ? (
                        <span className="ml-1 text-destructive">（有错误）</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
            {result.items.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                  无记录。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground md:hidden">
        窄屏隐藏「目标/详情」列，完整数据请导出 CSV。
      </p>
    </div>
  );
}
