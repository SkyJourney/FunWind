import Link from "next/link";
import { requireAdmin } from "@/lib/authz/require-admin";
import { buildAdminQuery } from "@/lib/admin/query";
import { pageBounds } from "@/lib/queries/paging";
import {
  MAIL_KINDS,
  MAIL_KIND_LABEL,
  emailLogSummary,
  parseEmailLogFilter,
  queryEmailLogs,
} from "@/lib/mail/log-query";
import { AdminFilterBar } from "@/components/admin/admin-filter-bar";
import { AdminListMeta, AdminTable } from "@/components/admin/admin-list";
import { Pagination } from "@/components/content/pagination";

export const dynamic = "force-dynamic";
export const metadata = { title: "邮件" };

type Params = {
  searchParams: Promise<Record<string, string | undefined>>;
};

const PER_PAGE = 50;

/**
 * 邮件发送记录（admin.logs，与审计日志同档）：凡经 lib/mail 发出的邮件成败皆在此可查——
 * 是邮件通道的审计日志。不含正文（验证链接含一次性令牌）；保留 90 天，超期自动清理。
 */
export default async function AdminMailPage({ searchParams }: Params) {
  await requireAdmin("admin.logs");
  const sp = await searchParams;
  const filter = parseEmailLogFilter(sp);
  filter.limit = PER_PAGE;

  const [{ items, total }, summary] = await Promise.all([
    queryEmailLogs(filter),
    emailLogSummary(),
  ]);
  const { page: safePage, totalPages } = pageBounds(total, filter.page ?? 1, PER_PAGE);
  const qs = { status: filter.status, kind: filter.kind, q: filter.q };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          最近 24 小时：发送 {summary.sent} 封 · 失败 {summary.failed} 封 · 共 {total} 条记录
        </p>
        <Link
          href="/admin/mail/preview"
          className="rounded-lg border px-3 py-1.5 text-xs hover:bg-accent"
        >
          模板预览
        </Link>
      </div>

      <AdminFilterBar
        action="/admin/mail"
        resetHref="/admin/mail"
        placeholder="收件人邮箱片段或用户 id"
        defaultValue={filter.q ?? ""}
      >
        <select
          name="status"
          defaultValue={filter.status ?? ""}
          aria-label="状态"
          className="rounded-lg border bg-background px-2.5 py-1.5 text-xs"
        >
          <option value="">全部状态</option>
          <option value="sent">成功</option>
          <option value="failed">失败</option>
        </select>
        <select
          name="kind"
          defaultValue={filter.kind ?? ""}
          aria-label="类别"
          className="rounded-lg border bg-background px-2.5 py-1.5 text-xs"
        >
          <option value="">全部类别</option>
          {MAIL_KINDS.map((k) => (
            <option key={k} value={k}>
              {MAIL_KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </AdminFilterBar>

      <AdminListMeta total={total} page={safePage} totalPages={totalPages} />
      <Pagination
        basePath={buildAdminQuery("/admin/mail", qs)}
        page={safePage}
        totalPages={totalPages}
      />

      <AdminTable
        colSpan={7}
        hasRows={items.length > 0}
        emptyText="无记录。站点发出第一封邮件后会出现在这里。"
        head={
          <>
            <th className="px-3 py-2">id</th>
            <th className="px-3 py-2">时间</th>
            <th className="px-3 py-2">类别 / 场景</th>
            <th className="px-3 py-2">收件人</th>
            <th className="px-3 py-2">主题</th>
            <th className="px-3 py-2">状态</th>
            <th className="hidden px-3 py-2 md:table-cell">耗时</th>
          </>
        }
        rows={items.map((r) => (
          <tr key={r.id} className="border-t align-top">
            <td className="px-3 py-1.5 tabular-nums">{r.id}</td>
            <td className="px-3 py-1.5 whitespace-nowrap">{r.createdAt}</td>
            <td className="px-3 py-1.5">
              {MAIL_KIND_LABEL[r.kind as keyof typeof MAIL_KIND_LABEL] ?? r.kind}
              <span className="ml-1 font-mono text-muted-foreground">{r.scene}</span>
            </td>
            <td className="px-3 py-1.5">
              <div className="max-w-48 truncate" title={r.toEmail}>
                {r.toEmail}
              </div>
              {r.userId !== null && <span className="text-muted-foreground">uid {r.userId}</span>}
            </td>
            <td className="px-3 py-1.5">
              <div className="max-w-64 truncate" title={r.subject}>
                {r.subject}
              </div>
            </td>
            <td className="px-3 py-1.5">
              {r.status === "sent" ? (
                <span className="text-success">成功</span>
              ) : (
                <span className="text-destructive" title={r.error ?? undefined}>
                  失败{r.error ? "（悬停见原因）" : ""}
                </span>
              )}
            </td>
            <td className="hidden px-3 py-1.5 tabular-nums md:table-cell">
              {r.durationMs !== null ? `${r.durationMs}ms` : "—"}
            </td>
          </tr>
        ))}
      />
      <p className="text-xs text-muted-foreground">
        记录只含收件人 / 主题 / 场景 / 结果，不含邮件正文；保留 90 天，超期自动清理。
      </p>
    </div>
  );
}
