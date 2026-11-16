import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Files, MessageSquare } from "lucide-react";
import { checkPermission, getModeratedForumIds } from "@/lib/authz/service";
import { getCurrentSubject } from "@/lib/authz/subject";
import { getCurrentUser } from "@/lib/auth/session";
import {
  listContentsPage,
  type ContentKind,
  type ContentStateFilter,
} from "@/lib/moderation/contents";
import { fmtDateTime } from "@/lib/admin/format";
import { buildAdminQuery, parseAdminPage } from "@/lib/admin/query";
import { AdminTabs } from "@/components/admin/admin-tabs";
import { AdminFilterBar } from "@/components/admin/admin-filter-bar";
import { AdminFlash } from "@/components/admin/admin-flash";
import { ForumSelect } from "@/components/admin/forum-select";
import { Pagination } from "@/components/content/pagination";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { SubmitButton } from "@/components/ui/submit-button";
import { EmptyState } from "@/components/empty-state";
import { restorePostAction } from "@/app/actions/posts";
import {
  approveContentAction,
  approveReviewBulkAction,
  disableContentAction,
  hideContentAction,
  purgeContentAction,
  rejectContentAction,
  rejectReviewBulkAction,
  threadFlagsAction,
} from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "内容管理" };

const STATE_TABS: { key: ContentStateFilter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "visible", label: "正常" },
  { key: "pending", label: "待审核" },
  { key: "rejected", label: "已驳回" },
  { key: "hidden", label: "已屏蔽" },
  { key: "disabled", label: "已封禁" },
  { key: "deleted", label: "已删除" },
];

const STATE_BADGE: Record<string, { text: string; cls: string }> = {
  visible: { text: "正常", cls: "bg-success/10 text-success" },
  pending: { text: "待审核", cls: "bg-warning/10 text-warning" },
  rejected: { text: "已驳回", cls: "bg-destructive/10 text-destructive" },
  hidden: { text: "已屏蔽", cls: "bg-muted text-muted-foreground" },
  disabled: { text: "已封禁", cls: "bg-destructive/10 text-destructive" },
  deleted: { text: "已删除", cls: "bg-muted text-muted-foreground" },
};

/**
 * 内容管理（M9.5 §9.2-A 单菜单 + 主题/回帖页签；M19 吸收原「内容审核」页能力）：
 * - 待审核态 = 版主审核队列（先到先审正序）+ checkbox 批量通过/驳回（每次 ≤50，逐条独立事务）；
 * - 已屏蔽/已删除行可恢复（restorePost）；已封禁行可彻底删除（disabled → deleted 终态，不可恢复）；
 * - 版主看所辖版块，admin.recycle / site.admin 看全站；行内操作与前台同一套服务。
 */
export default async function AdminContentsPage({
  searchParams,
}: {
  searchParams: Promise<{
    kind?: string;
    q?: string;
    forum?: string;
    state?: string;
    page?: string;
    error?: string;
    approved?: string;
    rejected?: string;
    purged?: string;
    saved?: string;
    disabled?: string;
    hidden?: string;
  }>;
}) {
  // 入口鉴权（layout 等价形态：admin-entry-guard 允许首个 await 为 getCurrentUser + 权限判定）：
  // 版主可达（forum.moderate 作用域）、admin.recycle（回收站全站视角）、site.admin
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const subject = await getCurrentSubject();
  const [isSiteAdmin, hasRecycle, moderated] = await Promise.all([
    checkPermission(subject, "site.admin"),
    checkPermission(subject, "admin.recycle"),
    getModeratedForumIds(subject),
  ]);
  if (!isSiteAdmin.allowed && !hasRecycle.allowed && moderated.length === 0) notFound();
  const sp = await searchParams;

  const kind: ContentKind = sp.kind === "reply" ? "reply" : "thread";
  const q = typeof sp.q === "string" ? sp.q : "";
  const forumId = Number(sp.forum ?? "0") || undefined;
  const state = STATE_TABS.some((t) => t.key === sp.state)
    ? (sp.state as ContentStateFilter)
    : "all";
  const page = parseAdminPage(sp.page, "number-or-one");

  // 作用域：site.admin / admin.recycle 看全站；版主看所辖版块
  const scopeForumIds = isSiteAdmin.allowed || hasRecycle.allowed ? null : moderated;

  const {
    items,
    total,
    page: safePage,
    totalPages,
  } = await listContentsPage({
    kind,
    q,
    forumId,
    state,
    page,
    scopeForumIds,
    // 待审核态是审核队列：按提交时间正序（先到先审，M19 自 review 页合并）
    order: state === "pending" ? "queue" : undefined,
  });

  const query = {
    ...(kind === "reply" ? { kind } : {}),
    ...(q ? { q } : {}),
    ...(forumId ? { forum: forumId } : {}),
    ...(state !== "all" ? { state } : {}),
  };
  const baseQuery = (over: Record<string, string> = {}) =>
    buildAdminQuery("/admin/contents", query, over);

  return (
    <div className="space-y-4">
      {sp.error && (
        <AdminFlash kind="error" dismissHref={baseQuery({ error: "" })}>
          {sp.error}
        </AdminFlash>
      )}
      {(sp.approved || sp.rejected || sp.purged || sp.saved || sp.disabled || sp.hidden) && (
        <AdminFlash
          kind="success"
          dismissHref={baseQuery({
            approved: "",
            rejected: "",
            purged: "",
            saved: "",
            disabled: "",
            hidden: "",
          })}
        >
          {sp.approved ? `已通过 ${sp.approved} 条（作者会收到通知；新内容已公开）。` : null}
          {sp.rejected
            ? `已驳回 ${sp.rejected} 条（作者会收到驳回理由，可修改后重新提交）。`
            : null}
          {sp.purged ? "内容已彻底删除（封禁终态不可恢复）。" : null}
          {sp.saved ? "主题设置已更新（锁定 / 置顶 / 精华）。" : null}
          {sp.disabled ? "内容已封禁（作者可见理由横幅，不可编辑重审）。" : null}
          {sp.hidden ? "内容已屏蔽。" : null}
        </AdminFlash>
      )}

      {/* 类型页签（形态已定稿：单菜单 + 页内页签） */}
      <AdminTabs
        label="内容类型"
        activeKey={kind}
        linkClassName="flex items-center gap-1.5 rounded-full border px-3 py-1"
        tabs={[
          {
            key: "thread",
            label: (
              <>
                <Files className="size-3.5" aria-hidden /> 主题
              </>
            ),
            href: baseQuery({ kind: "", page: "" }),
          },
          {
            key: "reply",
            label: (
              <>
                <MessageSquare className="size-3.5" aria-hidden /> 回帖
              </>
            ),
            href: baseQuery({ kind: "reply", page: "" }),
          },
        ]}
      />

      {/* 筛选：状态 + 板块 + 关键词 */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <AdminTabs
          label="内容状态"
          activeKey={state}
          className="flex flex-wrap gap-1.5"
          linkClassName="rounded-full border px-2.5 py-0.5 text-xs"
          tabs={STATE_TABS.map((t) => ({
            ...t,
            href: baseQuery({ state: t.key === "all" ? "" : t.key, page: "" }),
          }))}
        />
        <AdminFilterBar
          action="/admin/contents"
          method="get"
          className="flex flex-wrap items-center gap-1.5"
          submitClassName="rounded-lg border px-2.5 py-1 text-xs hover:bg-accent"
          hidden={{
            kind: kind === "reply" ? "reply" : undefined,
            state: state !== "all" ? state : undefined,
          }}
        >
          <ForumSelect
            name="forum"
            label="按板块筛选"
            defaultValue={forumId ?? null}
            allLabel="全部板块"
            className="rounded-lg border border-input bg-background px-2 py-1 text-xs"
          />
          <input
            name="q"
            defaultValue={q}
            placeholder={kind === "thread" ? "标题关键词" : "正文 / 标题关键词"}
            className="w-40 rounded-lg border bg-background px-2.5 py-1 text-xs"
          />
        </AdminFilterBar>
        <span className="text-xs text-muted-foreground">共 {total} 条</span>
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={kind === "thread" ? Files : MessageSquare}
          title="没有匹配条件的内容。"
          description="版主只看到所辖版块；admin.recycle / site.admin 可看全站。"
        />
      ) : (
        <ul className="space-y-2">
          {items.map((item) => {
            const badge = STATE_BADGE[item.state] ?? { text: item.state, cls: "bg-muted" };
            return (
              <li key={item.postId} className="rounded-xl border bg-card px-4 py-3">
                {/* 纵向统一排版（站长定稿）：内容渲染在上、管理交互整行沉底——
                    主题/回帖长度差异不影响操作区位置，多断点下排版一致；
                    待审核行左侧加批量勾选（form 属性关联页底批量条，HTML 禁止嵌套 form） */}
                <div
                  className={`min-w-0 ${item.state === "pending" ? "flex items-start gap-2" : ""}`}
                >
                  {item.state === "pending" && (
                    <input
                      type="checkbox"
                      name="postIds"
                      form="bulk-contents-form"
                      value={item.postId}
                      aria-label={`选择：${item.title}`}
                      className="mt-1 size-4 shrink-0"
                    />
                  )}
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      <Link href={`/t/${item.threadId}`} className="hover:text-primary">
                        {item.title}
                      </Link>
                      <span className={`ml-2 rounded px-1.5 py-0.5 text-xs ${badge.cls}`}>
                        {badge.text}
                      </span>
                      {item.authorBanned && (
                        <span className="ml-1 rounded bg-warning/10 px-1.5 py-0.5 text-xs text-warning">
                          作者已封禁
                        </span>
                      )}
                    </p>
                    {item.excerpt && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                        {item.excerpt}
                      </p>
                    )}
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {item.forumName} · {item.authorName ?? "已注销"}（uid {item.authorId}） ·{" "}
                      {fmtDateTime(item.createdAt)}
                      {item.isThread && item.replyCount !== null
                        ? ` · ${item.replyCount} 回帖`
                        : ""}
                      {item.isThread && item.isLocked ? " · 已锁定" : ""}
                      {item.isThread && item.isFeatured ? " · 精华" : ""}
                      {item.isThread && (item.pinLevel ?? 0) > 0 ? " · 已置顶" : ""}
                    </p>
                  </div>
                </div>

                {/* 管理交互行（统一沉底）：按当前状态给出可用动作 */}
                <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t pt-2.5">
                  {item.state === "pending" && (
                    <>
                      <form action={approveContentAction}>
                        <input type="hidden" name="postId" value={item.postId} />
                        <input type="hidden" name="back" value={baseQuery({})} />
                        <button
                          type="submit"
                          className="rounded-lg border px-2.5 py-1 text-xs hover:bg-accent"
                        >
                          通过
                        </button>
                      </form>
                      <form action={rejectContentAction} className="flex items-center gap-1">
                        <input type="hidden" name="postId" value={item.postId} />
                        <input type="hidden" name="back" value={baseQuery({})} />
                        <input
                          name="reason"
                          required
                          maxLength={255}
                          placeholder="驳回理由"
                          className="w-32 rounded-lg border bg-background px-2 py-1 text-xs"
                        />
                        <button
                          type="submit"
                          className="rounded-lg border px-2.5 py-1 text-xs text-destructive hover:bg-destructive/10"
                        >
                          驳回
                        </button>
                      </form>
                    </>
                  )}
                  {item.state === "visible" && (
                    <>
                      <form action={hideContentAction} className="flex items-center gap-1">
                        <input type="hidden" name="postId" value={item.postId} />
                        <input
                          name="reason"
                          required
                          maxLength={255}
                          placeholder="屏蔽理由"
                          className="w-32 rounded-lg border bg-background px-2 py-1 text-xs"
                        />
                        <button
                          type="submit"
                          className="rounded-lg border px-2.5 py-1 text-xs hover:bg-accent"
                        >
                          屏蔽
                        </button>
                      </form>
                      <form action={disableContentAction} className="flex items-center gap-1">
                        <input type="hidden" name="postId" value={item.postId} />
                        <input
                          name="reason"
                          required
                          maxLength={255}
                          placeholder="封禁理由（作者可见）"
                          aria-label="封禁理由（作者可见）"
                          className="w-36 rounded-lg border bg-background px-2 py-1 text-xs"
                        />
                        <ConfirmSubmit
                          title="封禁内容"
                          description="确认封禁？作者将看到封禁理由横幅，且不可编辑、不可重新提交审核（版主只能彻底删除，不可恢复）。"
                          className="rounded-lg border border-destructive/40 px-2.5 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-60"
                          pendingText="…"
                        >
                          封禁
                        </ConfirmSubmit>
                      </form>
                    </>
                  )}
                  {(item.state === "hidden" || item.state === "deleted") && (
                    <form action={restorePostAction} className="flex items-center gap-1">
                      <input type="hidden" name="postId" value={item.postId} />
                      <input
                        name="reason"
                        required
                        maxLength={255}
                        placeholder="恢复理由"
                        className="w-32 rounded-lg border bg-background px-2 py-1 text-xs"
                      />
                      <ConfirmSubmit
                        title="恢复内容"
                        description="确认恢复此内容？恢复后重新公开可见。"
                        className="rounded-lg border px-2.5 py-1 text-xs hover:bg-accent disabled:opacity-60"
                        pendingText="…"
                      >
                        恢复
                      </ConfirmSubmit>
                    </form>
                  )}
                  {item.state === "disabled" && (
                    <form action={purgeContentAction} className="flex items-center gap-1">
                      <input type="hidden" name="postId" value={item.postId} />
                      <input type="hidden" name="back" value={baseQuery({})} />
                      <input
                        name="reason"
                        required
                        maxLength={255}
                        placeholder="彻底删除理由"
                        className="w-36 rounded-lg border bg-background px-2 py-1 text-xs"
                      />
                      <ConfirmSubmit
                        title="彻底删除"
                        description="确认彻底删除？封禁终态删除后不可恢复、不可重审（disabled → deleted）。"
                        className="rounded-lg border border-destructive/40 px-2.5 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-60"
                        pendingText="…"
                      >
                        彻底删除
                      </ConfirmSubmit>
                    </form>
                  )}
                  {item.isThread && (
                    <form action={threadFlagsAction} className="flex items-center gap-1">
                      <input type="hidden" name="threadId" value={item.threadId} />
                      <input type="hidden" name="back" value={baseQuery({})} />
                      <label className="flex items-center gap-1 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          name="locked"
                          value="1"
                          defaultChecked={item.isLocked ?? false}
                          className="size-3.5"
                        />
                        锁定
                      </label>
                      <label className="flex items-center gap-1 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          name="featured"
                          value="1"
                          defaultChecked={item.isFeatured ?? false}
                          className="size-3.5"
                        />
                        精华
                      </label>
                      <select
                        name="pinLevel"
                        defaultValue={String(item.pinLevel ?? 0)}
                        aria-label="置顶级别"
                        className="rounded border bg-background px-1 py-0.5 text-xs"
                      >
                        <option value="0">不置顶</option>
                        <option value="1">版块置顶</option>
                        <option value="2">分区置顶</option>
                        <option value="3">全站置顶</option>
                      </select>
                      <button
                        type="submit"
                        className="rounded-lg border px-2 py-0.5 text-xs hover:bg-accent"
                      >
                        应用
                      </button>
                    </form>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* 批量操作条（仅待审核队列）：checkbox 经 form 属性归入本表单；back 保留当前筛选 */}
      {state === "pending" && items.length > 0 && (
        <form
          id="bulk-contents-form"
          className="sticky bottom-4 mt-4 flex flex-wrap items-center gap-2 rounded-xl border bg-card px-4 py-3 shadow-sm"
        >
          <input type="hidden" name="back" value={baseQuery({})} />
          <span className="text-sm text-muted-foreground">
            勾选待审内容后可批量操作（每次最多 50 条，按提交时间先到先审）
          </span>
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
      )}

      <Pagination basePath={baseQuery({})} page={safePage} totalPages={totalPages} />
    </div>
  );
}
