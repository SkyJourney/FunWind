import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ClipboardCheck } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { getCurrentSubject } from "@/lib/authz/subject";
import { getModeratedForumIds } from "@/lib/authz/service";
import { requireModerator } from "@/lib/authz/require-admin";
import { listReviewPage } from "@/lib/moderation/review";
import { fmtDateTime } from "@/lib/admin/format";
import { ForumSelect } from "@/components/admin/forum-select";
import { AdminFlash } from "@/components/admin/admin-flash";
import { Pagination } from "@/components/content/pagination";
import { restorePostAction } from "@/app/actions/posts";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  approveReviewAction,
  approveReviewBulkAction,
  rejectReviewAction,
  rejectReviewBulkAction,
} from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "内容审核" };

type Params = {
  searchParams: Promise<{
    tab?: string;
    forum?: string;
    kind?: string;
    page?: string;
    error?: string;
    approved?: string;
    rejected?: string;
  }>;
};

/**
 * 审核队列（M9.5 大本营标准重做）：SQL 分页（板块/类型筛选）+ 内容摘要行 + 批量通过/驳回。
 * 可见性：版主（持任一板块 forum.moderate）或 admin.recycle；队列内容按版主作用域过滤（服务层）。
 * 批量交互：checkbox 多选 → 页底浮动操作条「已选 N」；批量驳回共用一个理由输入（必填）。
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
  const forumId = Number(sp.forum ?? "0") || undefined;
  const kind = sp.kind === "thread" || sp.kind === "reply" ? sp.kind : undefined;
  const page = Number(sp.page ?? "1") || 1;

  const {
    items,
    total,
    page: safePage,
    totalPages,
  } = await listReviewPage(subject, {
    tab,
    forumId,
    kind,
    page,
  });

  const baseQuery = (over: Record<string, string>) => {
    const p = new URLSearchParams();
    if (tab !== "pending") p.set("tab", tab);
    if (forumId) p.set("forum", String(forumId));
    if (kind) p.set("kind", kind);
    for (const [k, v] of Object.entries(over)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    const qs = p.toString();
    return `/admin/review${qs ? `?${qs}` : ""}`;
  };

  return (
    <div className="space-y-4">
      {sp.error && (
        <AdminFlash kind="error" dismissHref={baseQuery({ error: "" })}>
          {sp.error}
        </AdminFlash>
      )}
      {sp.approved && (
        <AdminFlash kind="success" dismissHref={baseQuery({ approved: "" })}>
          已通过 {sp.approved} 条（作者会收到通知；新内容已公开）。
        </AdminFlash>
      )}
      {sp.rejected && (
        <AdminFlash kind="success" dismissHref={baseQuery({ rejected: "" })}>
          已驳回 {sp.rejected} 条（作者会收到驳回理由，可修改后重新提交）。
        </AdminFlash>
      )}

      <nav className="flex gap-2 text-sm" aria-label="审核视图">
        <Link
          href={baseQuery({ tab: "" })}
          className={`rounded-full border px-3 py-1 ${tab === "pending" ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
        >
          待审核
        </Link>
        <Link
          href={baseQuery({ tab: "removed" })}
          className={`rounded-full border px-3 py-1 ${tab === "removed" ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
        >
          已删隐内容
        </Link>
      </nav>

      {/* 筛选栏：板块（所辖）+ 类型 */}
      <form
        action="/admin/review"
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
        <select
          name="kind"
          defaultValue={kind ?? ""}
          aria-label="按类型筛选"
          className="rounded-lg border border-input bg-background px-2 py-1.5 text-sm"
        >
          <option value="">全部类型</option>
          <option value="thread">主题</option>
          <option value="reply">回帖</option>
        </select>
        <button type="submit" className="rounded-lg border px-3 py-1.5 hover:bg-accent">
          筛选
        </button>
        <Link
          href={tab === "removed" ? "/admin/review?tab=removed" : "/admin/review"}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          重置
        </Link>
        <span className="ml-auto text-xs text-muted-foreground">共 {total} 条</span>
      </form>

      {items.length === 0 ? (
        <EmptyState
          icon={ClipboardCheck}
          title={
            tab === "pending" ? "所辖板块没有待审核的内容。" : "所辖板块没有已删除或屏蔽的内容。"
          }
        />
      ) : tab === "pending" ? (
        <BulkList items={items} moderated={moderated} />
      ) : (
        <RemovedList items={items} moderated={moderated} />
      )}

      <Pagination basePath={baseQuery({})} page={safePage} totalPages={totalPages} />
    </div>
  );
}

/** 统一换行压缩的摘要文本 */
function excerptOf(raw: string | null): string | null {
  if (!raw) return null;
  const t = raw.replace(/\s+/g, " ").trim();
  return t.length > 0 ? t : null;
}

/** 待审核列表：一个大表单包住 checkbox 列与批量操作条（formAction 分流到批量 action） */
function BulkList({
  items,
  moderated,
}: {
  items: Awaited<ReturnType<typeof listReviewPage>>["items"];
  moderated: number[];
}) {
  return (
    <>
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.postId} className="rounded-xl border bg-card px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex min-w-0 items-start gap-2">
                {/* form 属性关联页底批量表单：checkbox 物理上在卡片里、提交时归入 bulk-form
                    （HTML 禁止嵌套 form——外层大 form 会拆掉逐条操作的独立 form） */}
                <input
                  type="checkbox"
                  name="postIds"
                  form="bulk-review-form"
                  value={item.postId}
                  aria-label={`选择：${item.title}`}
                  className="mt-1 size-4 shrink-0"
                />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    <span className="mr-1 text-xs text-muted-foreground">
                      {item.isThread ? "主题" : "回帖"} · {item.forumName}
                    </span>
                    <Link href={`/t/${item.threadId}`} className="hover:text-primary">
                      {item.title}
                    </Link>
                  </p>
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                    {excerptOf(item.excerpt) ?? "（无正文）"}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {item.authorName ?? "已注销"} 提交于 {fmtDateTime(item.createdAt)}（你管辖：
                    {moderated.join("、")}）
                  </p>
                </div>
              </div>
              <ApproveButtons postId={item.postId} />
            </div>
          </li>
        ))}
      </ul>

      {/* 批量操作条：吸底；批量通过走 formAction 分流，批量驳回共用理由输入 */}
      <form
        id="bulk-review-form"
        className="sticky bottom-4 mt-4 flex flex-wrap items-center gap-2 rounded-xl border bg-card px-4 py-3 shadow-sm"
      >
        <span className="text-sm text-muted-foreground">勾选后可批量操作（每次最多 50 条）</span>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <SubmitButton
            formAction={approveReviewBulkAction}
            className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            pendingText="…"
          >
            批量通过
          </SubmitButton>
          <input
            name="reason"
            placeholder="批量驳回理由（必填）"
            maxLength={500}
            className="w-44 rounded-lg border bg-background px-2.5 py-1.5 text-sm"
          />
          <ConfirmSubmit
            title="批量驳回"
            description="确认驳回所选内容？该理由将通知全部所选作者。"
            formAction={rejectReviewBulkAction}
            className="rounded-lg border px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-60"
            pendingText="…"
          >
            批量驳回
          </ConfirmSubmit>
        </span>
      </form>
    </>
  );
}

function ApproveButtons({ postId }: { postId: number }) {
  return (
    <>
      <form action={approveReviewAction}>
        <input type="hidden" name="postId" value={postId} />
        <SubmitButton
          className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          pendingText="…"
        >
          通过
        </SubmitButton>
      </form>
      <form action={rejectReviewAction} className="flex items-center gap-1">
        <input type="hidden" name="postId" value={postId} />
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
    </>
  );
}

/** 回收站列表（逐条恢复，不做批量） */
function RemovedList({
  items,
  moderated,
}: {
  items: Awaited<ReturnType<typeof listReviewPage>>["items"];
  moderated: number[];
}) {
  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item.postId} className="rounded-xl border bg-card px-4 py-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                <span className="mr-1 text-xs text-muted-foreground">
                  {item.isThread ? "主题" : "回帖"} · {item.forumName}
                </span>
                <Link href={`/t/${item.threadId}`} className="hover:text-primary">
                  {item.title}
                </Link>
              </p>
              <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                {excerptOf(item.excerpt) ?? "（无正文）"}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {item.authorName ?? "已注销"} 提交于 {fmtDateTime(item.createdAt)}（你管辖：
                {moderated.join("、")}）
              </p>
            </div>
            <form action={restorePostAction}>
              <input type="hidden" name="postId" value={item.postId} />
              <input
                name="reason"
                placeholder="恢复理由（必填）"
                maxLength={255}
                required
                className="w-44 rounded-lg border bg-background px-2.5 py-1.5 text-sm"
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
          </div>
        </li>
      ))}
    </ul>
  );
}
