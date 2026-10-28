import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ClipboardCheck } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { getCurrentSubject } from "@/lib/authz/subject";
import { getModeratedForumIds } from "@/lib/authz/service";
import { requireModerator } from "@/lib/authz/require-admin";
import { removedContent, reviewQueue } from "@/lib/moderation/review";
import { restorePostAction } from "@/app/actions/posts";
import { SubmitButton } from "@/components/ui/submit-button";
import { approveReviewAction, rejectReviewAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "内容审核" };

type Params = {
  searchParams: Promise<{ tab?: string; error?: string; approved?: string; rejected?: string }>;
};

/**
 * 审核队列（M9）：所辖板块的 pending 内容（主题+回帖）；「已删隐」tab = 回收站（恢复复用 restorePost）。
 * 可见性：版主（持任一板块 forum.moderate）或 admin.recycle；队列内容按版主作用域过滤（服务层）。
 */
export default async function ReviewPage({ searchParams }: Params) {
  // 入口门禁双保险（admin-entry-guard 约定：页面自身第一个 await 必须是鉴权）：
  // 审核页版主可达（不持 site.admin），用 requireModerator（未登录 redirect；否则要求持任一版主作用域）
  await requireModerator();
  const sp = await searchParams;
  const subject = await getCurrentSubject();
  if (subject.userId === null) notFound();
  const moderated = await getModeratedForumIds(subject);
  if (moderated.length === 0) notFound(); // 无版主权限的会员 → 404

  const tab = sp.tab === "removed" ? "removed" : "pending";
  const items = tab === "pending" ? await reviewQueue(subject) : await removedContent(subject);

  return (
    <div className="space-y-4">
      {sp.error && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {sp.error}
        </p>
      )}
      {sp.approved && (
        <p className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
          已通过（作者会收到通知；新内容已公开）。
        </p>
      )}
      {sp.rejected && (
        <p className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
          已驳回（作者会收到驳回理由，可修改后重新提交）。
        </p>
      )}

      <nav className="flex gap-2 text-sm" aria-label="审核视图">
        <Link
          href="/admin/review"
          className={`rounded-full border px-3 py-1 ${tab === "pending" ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
        >
          待审核
        </Link>
        <Link
          href="/admin/review?tab=removed"
          className={`rounded-full border px-3 py-1 ${tab === "removed" ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
        >
          已删隐内容
        </Link>
      </nav>

      {items.length === 0 ? (
        <EmptyState
          icon={ClipboardCheck}
          title={
            tab === "pending" ? "所辖板块没有待审核的内容。" : "所辖板块没有已删除或屏蔽的内容。"
          }
        />
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.postId} className="rounded-xl border bg-card px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    <span className="mr-1 text-xs text-muted-foreground">
                      {item.isThread ? "主题" : "回帖"} · {item.forumName}
                    </span>
                    <Link href={`/t/${item.threadId}`} className="hover:text-primary">
                      {item.title}
                    </Link>
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {item.authorName ?? "已注销"} 提交于 {item.createdAt}（你管辖：
                    {moderated.join("、")}）
                  </p>
                </div>
                {tab === "pending" ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <form action={approveReviewAction}>
                      <input type="hidden" name="postId" value={item.postId} />
                      <SubmitButton
                        className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                        pendingText="…"
                      >
                        通过
                      </SubmitButton>
                    </form>
                    <form action={rejectReviewAction} className="flex items-center gap-1">
                      <input type="hidden" name="postId" value={item.postId} />
                      <input
                        name="reason"
                        placeholder="驳回理由（必填）"
                        maxLength={255}
                        required
                        className="w-44 rounded-lg border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
                      />
                      <ConfirmSubmit
                        title="驳回内容"
                        description="确认驳回此内容并通知作者？"
                        className="rounded-lg border px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-60"
                        pendingText="…"
                      >
                        驳回
                      </ConfirmSubmit>
                    </form>
                  </div>
                ) : (
                  <form action={restorePostAction}>
                    <input type="hidden" name="postId" value={item.postId} />
                    <input
                      name="reason"
                      placeholder="恢复理由（必填）"
                      maxLength={255}
                      required
                      className="w-44 rounded-lg border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
                    />
                    <ConfirmSubmit
                      title="恢复内容"
                      description="确认恢复此内容？"
                      className="ml-1 rounded-lg border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-60"
                      pendingText="…"
                    >
                      恢复
                    </ConfirmSubmit>
                  </form>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
