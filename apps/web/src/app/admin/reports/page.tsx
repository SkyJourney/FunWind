import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import Link from "next/link";
import { requireAdmin } from "@/lib/authz/require-admin";
import { dismissReportBulkAction, handleReportAction } from "./actions";
import { listReportPage } from "@/lib/reports/service";
import { fmtDateTime } from "@/lib/admin/format";
import { ForumSelect } from "@/components/admin/forum-select";
import { AdminFlash } from "@/components/admin/admin-flash";
import { Pagination } from "@/components/content/pagination";

export const dynamic = "force-dynamic";
export const metadata = { title: "举报处理" };

type Params = {
  searchParams: Promise<{
    tab?: string;
    forum?: string;
    page?: string;
    error?: string;
    resolved?: string;
    dismissed?: string;
  }>;
};

const TABS = [
  { key: "pending" as const, label: "待处理" },
  { key: "resolved" as const, label: "已处置" },
  { key: "dismissed" as const, label: "已忽略" },
];

/** 举报队列（M9.5 重做）：状态 tab + 板块筛选 + 分页 + 批量忽略（说明统一回给举报人）。 */
export default async function AdminReportsPage({ searchParams }: Params) {
  await requireAdmin("admin.reports");
  const sp = await searchParams;
  const tab = TABS.some((t) => t.key === sp.tab)
    ? (sp.tab as "pending" | "resolved" | "dismissed")
    : "pending";
  const forumId = Number(sp.forum ?? "0") || undefined;
  const page = Math.max(1, Number(sp.page ?? "1") || 1);

  const { items, total } = await listReportPage({ status: tab, forumId, page });
  const totalPages = Math.max(1, Math.ceil(total / 20));

  const baseQuery = (over: Record<string, string>) => {
    const p = new URLSearchParams();
    if (tab !== "pending") p.set("tab", tab);
    if (forumId) p.set("forum", String(forumId));
    for (const [k, v] of Object.entries(over)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    const qs = p.toString();
    return `/admin/reports${qs ? `?${qs}` : ""}`;
  };

  return (
    <div className="space-y-4">
      {sp.error && (
        <AdminFlash kind="error" dismissHref={baseQuery({ error: "" })}>
          {sp.error}
        </AdminFlash>
      )}
      {(sp.resolved || sp.dismissed) && (
        <AdminFlash kind="success" dismissHref={baseQuery({ resolved: "", dismissed: "" })}>
          {sp.resolved ? `已处置 ${sp.resolved} 条` : `已忽略 ${sp.dismissed} 条`}
          （举报人会收到处理说明）。
        </AdminFlash>
      )}

      <nav className="flex gap-2 text-sm" aria-label="举报状态">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={baseQuery({ tab: t.key === "pending" ? "" : t.key, page: "" })}
            className={`rounded-full border px-3 py-1 ${tab === t.key ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      <form
        action="/admin/reports"
        method="get"
        className="flex flex-wrap items-center gap-2 text-sm"
      >
        {tab !== "pending" && <input type="hidden" name="tab" value={tab} />}
        <ForumSelect
          name="forum"
          label="按板块筛选"
          defaultValue={forumId ?? null}
          allLabel="全部板块"
          className="rounded-lg border border-input bg-background px-2 py-1.5 text-sm"
        />
        <button type="submit" className="rounded-lg border px-3 py-1.5 hover:bg-accent">
          筛选
        </button>
        <Link
          href={tab === "pending" ? "/admin/reports" : `/admin/reports?tab=${tab}`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          重置
        </Link>
        <span className="ml-auto text-xs text-muted-foreground">共 {total} 条</span>
      </form>

      {items.length === 0 ? (
        <p className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
          该状态下没有举报。
        </p>
      ) : tab === "pending" ? (
        <>
          <ul className="space-y-2">
            {items.map((item) => (
              <li key={item.id} className="rounded-xl border bg-card px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="flex min-w-0 items-start gap-2">
                    <input
                      type="checkbox"
                      name="reportIds"
                      form="bulk-reports-form"
                      value={item.id}
                      aria-label={`选择举报：${item.threadTitle}`}
                      className="mt-1 size-4 shrink-0"
                    />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        <Link href={`/t/${item.threadId}`} className="hover:text-primary">
                          {item.threadTitle}
                        </Link>
                        <span className="ml-1 text-xs text-muted-foreground">
                          （帖子 #{item.postId}）
                        </span>
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {item.reporterName ?? "已注销"} 举报于 {fmtDateTime(item.createdAt)}：
                        {item.reason}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <form action={handleReportAction} className="flex items-center gap-1">
                      <input type="hidden" name="reportId" value={item.id} />
                      <input type="hidden" name="outcome" value="resolved" />
                      <input
                        name="note"
                        required
                        maxLength={255}
                        placeholder="处理说明（回给举报人）"
                        className="w-48 rounded-lg border bg-background px-2.5 py-1.5 text-sm"
                      />
                      <ConfirmSubmit
                        title="处理举报"
                        description="确认提交此举报处理结果？"
                        className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                        pendingText="…"
                      >
                        处置
                      </ConfirmSubmit>
                    </form>
                    <form action={handleReportAction}>
                      <input type="hidden" name="reportId" value={item.id} />
                      <input type="hidden" name="outcome" value="dismissed" />
                      <input type="hidden" name="note" value="经核实不构成违规" />
                      <ConfirmSubmit
                        title="处理举报"
                        description="确认提交此举报处理结果？"
                        className="rounded-lg border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-60"
                        pendingText="…"
                      >
                        忽略
                      </ConfirmSubmit>
                    </form>
                  </div>
                </div>
              </li>
            ))}
          </ul>

          {/* 批量忽略条（吸底）：忽略说明统一，适合批量；checkbox 经 form 属性归入本表单 */}
          <form
            id="bulk-reports-form"
            className="sticky bottom-4 mt-4 flex flex-wrap items-center gap-2 rounded-xl border bg-card px-4 py-3 shadow-sm"
          >
            <span className="text-sm text-muted-foreground">
              勾选后批量忽略（说明统一「经核实不构成违规」）
            </span>
            <ConfirmSubmit
              title="批量忽略"
              description="确认忽略所选举报？将统一回复「经核实不构成违规」并通知举报人。"
              formAction={dismissReportBulkAction}
              className="ml-auto rounded-lg border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-60"
              pendingText="…"
            >
              批量忽略已选
            </ConfirmSubmit>
          </form>
        </>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.id} className="rounded-xl border bg-card px-4 py-3">
              <p className="truncate text-sm font-medium">
                <Link href={`/t/${item.threadId}`} className="hover:text-primary">
                  {item.threadTitle}
                </Link>
                <span className="ml-1 text-xs text-muted-foreground">（帖子 #{item.postId}）</span>
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {item.reporterName ?? "已注销"} 举报于 {fmtDateTime(item.createdAt)}：{item.reason}
              </p>
            </li>
          ))}
        </ul>
      )}

      <Pagination basePath={baseQuery({})} page={page} totalPages={totalPages} />
    </div>
  );
}
