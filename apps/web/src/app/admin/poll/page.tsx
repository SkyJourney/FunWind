import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import Link from "next/link";
import { ChartNoAxesColumn } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { SubmitButton } from "@/components/ui/submit-button";
import { requireModerator } from "@/lib/authz/require-admin";
import { getCurrentSubject } from "@/lib/authz/subject";
import { pollAdminList } from "@/lib/poll/admin";
import { closePollAction, deletePollAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "投票管理" };

type Params = {
  searchParams: Promise<{
    error?: string;
    closed?: string;
    deleted?: string;
    "confirm-delete"?: string;
  }>;
};

/** 投票管理（M10 补做）：全站列表（site.admin）；关闭/删除（版主作用域内亦可，服务层判定）。 */
export default async function AdminPollPage({ searchParams }: Params) {
  // 版主可达（所辖板块的投票）；site.admin 全站——服务层 pollAdminList/guardAndMutate 做作用域判定
  await requireModerator();
  const sp = await searchParams;
  const items = await pollAdminList(await getCurrentSubject());
  // 无 JS 回退（M10.6d）：?confirm-delete=<pollId> 渲染原生表单确认段（作用域由 deletePollAction 服务层判定）
  const confirmDeleteId = Number(sp["confirm-delete"]);
  const confirmDelete = items.find((p) => p.pollId === confirmDeleteId);

  return (
    <div className="space-y-4">
      {sp.error && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {sp.error}
        </p>
      )}
      {sp.closed && (
        <p className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
          投票已关闭。
        </p>
      )}
      {sp.deleted && (
        <p className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
          投票已删除（主题保留为普通帖）。
        </p>
      )}

      {confirmDelete && (
        <div
          role="alertdialog"
          aria-label="确认删除投票"
          className="rounded-xl border border-warning/40 bg-warning/10 p-4"
        >
          <p className="text-sm font-medium">
            无脚本模式 · 确认删除投票「{confirmDelete.title}」？
          </p>
          <p className="mt-1 text-xs text-warning">投票数据将删除，主题保留为普通帖。</p>
          <form action={deletePollAction} className="mt-3 flex gap-2">
            <input type="hidden" name="pollId" value={confirmDelete.pollId} />
            <SubmitButton className="rounded-lg bg-destructive px-4 py-1.5 text-sm font-medium text-white hover:bg-destructive/90 disabled:opacity-60">
              确认删除
            </SubmitButton>
          </form>
        </div>
      )}

      {items.length === 0 ? (
        <EmptyState icon={ChartNoAxesColumn} title="没有投票（或你管辖的板块内没有）。" />
      ) : (
        <ul className="space-y-2">
          {items.map((p) => (
            <li key={p.pollId} className="rounded-xl border bg-card px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    <Link href={`/t/${p.threadId}`} className="hover:text-primary">
                      {p.title}
                    </Link>
                    <span className="ml-1 text-xs text-muted-foreground">
                      （{p.forumName} · {p.optionCount} 选项 · {p.totalVotes} 票 / {p.voterCount}{" "}
                      人）
                    </span>
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {p.closed ? `已截止（${p.endsAt}）` : p.endsAt ? `截止于 ${p.endsAt}` : "长期"}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {!p.closed && (
                    <form action={closePollAction}>
                      <input type="hidden" name="pollId" value={p.pollId} />
                      <ConfirmSubmit
                        title="关闭投票"
                        description="确认关闭此投票？"
                        className="rounded-lg border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-60"
                        pendingText="…"
                      >
                        关闭投票
                      </ConfirmSubmit>
                    </form>
                  )}
                  <form action={deletePollAction}>
                    <input type="hidden" name="pollId" value={p.pollId} />
                    <ConfirmSubmit
                      title="删除投票"
                      description="确认删除此投票？主题将保留。"
                      className="rounded-lg border px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-60"
                      pendingText="…"
                    >
                      删除投票
                    </ConfirmSubmit>
                    <noscript>
                      <a
                        href={`?confirm-delete=${p.pollId}`}
                        className="ml-2 text-xs text-warning underline"
                      >
                        无脚本删除
                      </a>
                    </noscript>
                  </form>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
