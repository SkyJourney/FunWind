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
import { AdminFlash } from "@/components/admin/admin-flash";
import { ForumSelect } from "@/components/admin/forum-select";
import { Pagination } from "@/components/content/pagination";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { EmptyState } from "@/components/empty-state";
import {
  approveContentAction,
  disableContentAction,
  hideContentAction,
  rejectContentAction,
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
 * 内容管理（M9.5 §9.2-A，单菜单 + 主题/回帖类型页签）：
 * 版主看所辖版块，admin.recycle / site.admin 看全站；行内操作与前台同一套 action。
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
  const page = Math.max(1, Number(sp.page ?? "1") || 1);

  // 作用域：site.admin / admin.recycle 看全站；版主看所辖版块
  const scopeForumIds = isSiteAdmin.allowed || hasRecycle.allowed ? null : moderated;

  const { items, total } = await listContentsPage({ kind, q, forumId, state, page, scopeForumIds });
  const totalPages = Math.max(1, Math.ceil(total / 20));

  const baseQuery = (over: Record<string, string>) => {
    const p = new URLSearchParams();
    if (kind === "reply") p.set("kind", "reply");
    if (q) p.set("q", q);
    if (forumId) p.set("forum", String(forumId));
    if (state !== "all") p.set("state", state);
    for (const [k, v] of Object.entries(over)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    const qs = p.toString();
    return `/admin/contents${qs ? `?${qs}` : ""}`;
  };

  return (
    <div className="space-y-4">
      {sp.error && (
        <AdminFlash kind="error" dismissHref={baseQuery({ error: "" })}>
          {sp.error}
        </AdminFlash>
      )}
      {(sp.saved || sp.disabled || sp.hidden) && (
        <AdminFlash kind="success" dismissHref={baseQuery({ saved: "", disabled: "", hidden: "" })}>
          {sp.saved ? "主题设置已更新（锁定 / 置顶 / 精华）。" : null}
          {sp.disabled ? "内容已封禁（作者可见理由横幅，不可编辑重审）。" : null}
          {sp.hidden ? "内容已屏蔽。" : null}
        </AdminFlash>
      )}

      {/* 类型页签（形态已定稿：单菜单 + 页内页签） */}
      <nav className="flex gap-2 text-sm" aria-label="内容类型">
        <Link
          href={baseQuery({ kind: "", page: "" })}
          className={`flex items-center gap-1.5 rounded-full border px-3 py-1 ${
            kind === "thread" ? "bg-primary text-primary-foreground" : "hover:bg-accent"
          }`}
        >
          <Files className="size-3.5" aria-hidden /> 主题
        </Link>
        <Link
          href={baseQuery({ kind: "reply", page: "" })}
          className={`flex items-center gap-1.5 rounded-full border px-3 py-1 ${
            kind === "reply" ? "bg-primary text-primary-foreground" : "hover:bg-accent"
          }`}
        >
          <MessageSquare className="size-3.5" aria-hidden /> 回帖
        </Link>
      </nav>

      {/* 筛选：状态 + 板块 + 关键词 */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <nav className="flex flex-wrap gap-1.5" aria-label="内容状态">
          {STATE_TABS.map((t) => (
            <Link
              key={t.key}
              href={baseQuery({ state: t.key === "all" ? "" : t.key, page: "" })}
              className={`rounded-full border px-2.5 py-0.5 text-xs ${
                state === t.key ? "bg-primary text-primary-foreground" : "hover:bg-accent"
              }`}
            >
              {t.label}
            </Link>
          ))}
        </nav>
        <form action="/admin/contents" method="get" className="flex flex-wrap items-center gap-1.5">
          {kind === "reply" && <input type="hidden" name="kind" value="reply" />}
          {state !== "all" && <input type="hidden" name="state" value={state} />}
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
          <button type="submit" className="rounded-lg border px-2.5 py-1 text-xs hover:bg-accent">
            筛选
          </button>
        </form>
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
                    主题/回帖长度差异不影响操作区位置，多断点下排版一致 */}
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
                    {item.isThread && item.replyCount !== null ? ` · ${item.replyCount} 回帖` : ""}
                    {item.isThread && item.isLocked ? " · 已锁定" : ""}
                    {item.isThread && item.isFeatured ? " · 精华" : ""}
                    {item.isThread && (item.pinLevel ?? 0) > 0 ? " · 已置顶" : ""}
                  </p>
                </div>

                {/* 管理交互行（统一沉底）：按当前状态给出可用动作 */}
                <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t pt-2.5">
                  {item.state === "pending" && (
                    <>
                      <form action={approveContentAction}>
                        <input type="hidden" name="postId" value={item.postId} />
                        <button
                          type="submit"
                          className="rounded-lg border px-2.5 py-1 text-xs hover:bg-accent"
                        >
                          通过
                        </button>
                      </form>
                      <form action={rejectContentAction} className="flex items-center gap-1">
                        <input type="hidden" name="postId" value={item.postId} />
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

      <Pagination basePath={baseQuery({})} page={page} totalPages={totalPages} />
    </div>
  );
}
