import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChartNoAxesColumn } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { SubmitButton } from "@/components/ui/submit-button";
import { requireModerator } from "@/lib/authz/require-admin";
import { getCurrentSubject } from "@/lib/authz/subject";
import { checkPermission } from "@/lib/authz/service";
import { getModeratedForumIds } from "@/lib/authz/service";
import { listPollPage } from "@/lib/poll/admin";
import { closePollAction, deletePollAction, reopenPollAction } from "./actions";
import { fmtDateTime } from "@/lib/admin/format";
import { ForumSelect } from "@/components/admin/forum-select";
import { AdminFlash } from "@/components/admin/admin-flash";
import { Pagination } from "@/components/content/pagination";

export const dynamic = "force-dynamic";
export const metadata = { title: "投票管理" };

type Params = {
  searchParams: Promise<{
    tab?: string;
    forum?: string;
    page?: string;
    error?: string;
    closed?: string;
    deleted?: string;
    reopened?: string;
    "confirm-delete"?: string;
  }>;
};

const TABS = [
  { key: "all" as const, label: "全部" },
  { key: "open" as const, label: "进行中" },
  { key: "closed" as const, label: "已截止" },
];

/** 投票管理（M9.5 重做）：状态 tab + 板块筛选 + 分页（N+1 修复）+ 重开投票（误关可救）+ 影响面确认。 */
export default async function AdminPollPage({ searchParams }: Params) {
  // 版主可达（所辖板块的投票）；site.admin 全站——服务层 guardAndMutate 做行级判定
  await requireModerator();
  const sp = await searchParams;
  const tab = TABS.some((t) => t.key === sp.tab) ? (sp.tab as "all" | "open" | "closed") : "all";
  const forumId = Number(sp.forum ?? "0") || undefined;
  const page = Math.max(1, Number(sp.page ?? "1") || 1);

  const subject = await getCurrentSubject();
  const isSiteAdmin = (await checkPermission(subject, "site.admin")).allowed;
  const moderated = isSiteAdmin ? null : await getModeratedForumIds(subject);
  if (!isSiteAdmin && moderated !== null && moderated.length === 0) notFound();

  const { items, total } = await listPollPage({ status: tab, forumId, page, moderated });
  const totalPages = Math.max(1, Math.ceil(total / 20));
  // 无 JS 回退（M10.6d 惯例）：?confirm-delete=<pollId> 渲染页顶原生确认段
  const confirmDeleteId = Number(sp["confirm-delete"]);
  const confirmDelete = items.find((p) => p.pollId === confirmDeleteId);

  const baseQuery = (over: Record<string, string>) => {
    const p = new URLSearchParams();
    if (tab !== "all") p.set("tab", tab);
    if (forumId) p.set("forum", String(forumId));
    for (const [k, v] of Object.entries(over)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    const qs = p.toString();
    return `/admin/poll${qs ? `?${qs}` : ""}`;
  };

  return (
    <div className="space-y-4">
      {sp.error && (
        <AdminFlash kind="error" dismissHref={baseQuery({ error: "" })}>
          {sp.error}
        </AdminFlash>
      )}
      {sp.closed && (
        <AdminFlash kind="success" dismissHref={baseQuery({ closed: "" })}>
          投票已关闭（可随时「重开」恢复进行中）。
        </AdminFlash>
      )}
      {sp.reopened && (
        <AdminFlash kind="success" dismissHref={baseQuery({ reopened: "" })}>
          投票已重开，恢复进行中。
        </AdminFlash>
      )}
      {sp.deleted && (
        <AdminFlash kind="success" dismissHref={baseQuery({ deleted: "" })}>
          投票已删除（选项、票数一并移除，主题恢复普通帖）。
        </AdminFlash>
      )}
      {confirmDelete && (
        <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 p-4">
          <p className="text-sm">
            确认删除投票「{confirmDelete.title}」？将移除 {confirmDelete.optionCount} 个选项与{" "}
            {confirmDelete.totalVotes} 张票（{confirmDelete.voterCount} 人参与），不可恢复。
          </p>
          <form action={deletePollAction} className="mt-2 flex gap-2">
            <input type="hidden" name="pollId" value={confirmDelete.pollId} />
            <button
              type="submit"
              className="rounded-lg bg-destructive px-3 py-1.5 text-sm text-destructive-foreground hover:bg-destructive/90"
            >
              确认删除
            </button>
            <Link
              href={baseQuery({ "confirm-delete": "" })}
              className="rounded-lg border px-3 py-1.5 text-sm hover:bg-accent"
            >
              取消
            </Link>
          </form>
        </div>
      )}

      <nav className="flex gap-2 text-sm" aria-label="投票状态">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={baseQuery({ tab: t.key === "all" ? "" : t.key, page: "" })}
            className={`rounded-full border px-3 py-1 ${tab === t.key ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      <form action="/admin/poll" method="get" className="flex flex-wrap items-center gap-2 text-sm">
        {tab !== "all" && <input type="hidden" name="tab" value={tab} />}
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
          href={tab === "all" ? "/admin/poll" : `/admin/poll?tab=${tab}`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          重置
        </Link>
        <span className="ml-auto text-xs text-muted-foreground">共 {total} 个</span>
      </form>

      {items.length === 0 ? (
        <EmptyState icon={ChartNoAxesColumn} title="没有投票（或你管辖的板块内没有）。" />
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.pollId} className="rounded-xl border bg-card px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    <Link href={`/t/${item.threadId}`} className="hover:text-primary">
                      {item.title}
                    </Link>
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {item.forumName} · {item.optionCount} 个选项 · {item.totalVotes} 票 /{" "}
                    {item.voterCount} 人
                    {item.endsAt
                      ? item.closed
                        ? ` · 已截止（${fmtDateTime(item.endsAt)}）`
                        : ` · 截止 ${fmtDateTime(item.endsAt)}`
                      : " · 进行中（无截止）"}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {item.closed ? (
                    <form action={reopenPollAction}>
                      <input type="hidden" name="pollId" value={item.pollId} />
                      <ConfirmSubmit
                        title="重开投票"
                        description="确认重开此投票？截止限制将取消，恢复进行中。"
                        className="rounded-lg border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-60"
                        pendingText="…"
                      >
                        重开
                      </ConfirmSubmit>
                    </form>
                  ) : (
                    <form action={closePollAction}>
                      <input type="hidden" name="pollId" value={item.pollId} />
                      <SubmitButton
                        className="rounded-lg border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-60"
                        pendingText="…"
                      >
                        关闭
                      </SubmitButton>
                    </form>
                  )}
                  <form action={deletePollAction}>
                    <input type="hidden" name="pollId" value={item.pollId} />
                    <ConfirmSubmit
                      title="删除投票"
                      description={`确认删除此投票？将移除 ${item.optionCount} 个选项与 ${item.totalVotes} 张票（${item.voterCount} 人参与），不可恢复。`}
                      className="rounded-lg border border-destructive/40 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-60"
                      pendingText="…"
                    >
                      删除
                    </ConfirmSubmit>
                  </form>
                  {/* noscript 回退：无 JS 时给页顶确认段的入口 */}
                  <noscript>
                    <Link
                      href={baseQuery({ "confirm-delete": String(item.pollId) })}
                      className="rounded-lg border px-3 py-1.5 text-sm hover:bg-accent"
                    >
                      删除（无脚本确认）
                    </Link>
                  </noscript>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Pagination basePath={baseQuery({})} page={page} totalPages={totalPages} />
    </div>
  );
}
