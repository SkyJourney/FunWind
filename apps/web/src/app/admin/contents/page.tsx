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
import { buildAdminQuery, parseAdminListParams, parseAdminPage } from "@/lib/admin/query";
import { AdminTabs } from "@/components/admin/admin-tabs";
import { AdminFilterBar } from "@/components/admin/admin-filter-bar";
import { AdminFlash } from "@/components/admin/admin-flash";
import { ForumSelect } from "@/components/admin/forum-select";
import { AdminListPager } from "@/components/admin/admin-list";
import { flashText } from "@/lib/admin/flash";
import { EmptyState } from "@/components/empty-state";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { SubmitButton } from "@/components/ui/submit-button";
import { ContentRow } from "./content-row";
import { approveReviewBulkAction, rejectReviewBulkAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "内容管理" };

const CONTENTS_OK: Record<string, string> = {
  approved: "已通过（作者会收到通知；新内容已公开）。",
  rejected: "已驳回（作者会收到驳回理由，可修改后重新提交）。",
  purged: "内容已彻底删除（封禁终态不可恢复）。",
  "thread-flags": "主题设置已更新（锁定 / 置顶 / 精华）。",
  disabled: "内容已封禁（作者可见理由横幅，不可编辑重审）。",
  hidden: "内容已屏蔽。",
};

const STATE_TABS: { key: ContentStateFilter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "visible", label: "正常" },
  { key: "pending", label: "待审核" },
  { key: "rejected", label: "已驳回" },
  { key: "hidden", label: "已屏蔽" },
  { key: "disabled", label: "已封禁" },
  { key: "deleted", label: "已删除" },
];

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
    size?: string;
    err?: string;
    ok?: string;
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
  const { size } = parseAdminListParams(sp);

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
    perPage: size !== 20 ? size : undefined,
    scopeForumIds,
    // 待审核态是审核队列：按提交时间正序（先到先审，M19 自 review 页合并）
    order: state === "pending" ? "queue" : undefined,
  });

  const query = {
    ...(kind === "reply" ? { kind } : {}),
    ...(q ? { q } : {}),
    ...(forumId ? { forum: forumId } : {}),
    ...(state !== "all" ? { state } : {}),
    ...(size !== 20 ? { size } : {}),
  };
  const baseQuery = (over: Record<string, string> = {}) =>
    buildAdminQuery("/admin/contents", query, over);

  return (
    <div className="space-y-4">
      {sp.err && (
        <AdminFlash kind="error" dismissHref={baseQuery({ err: "" })}>
          {sp.err}
        </AdminFlash>
      )}
      {sp.ok && (
        <AdminFlash kind="success" dismissHref={baseQuery({ ok: "" })}>
          {flashText(CONTENTS_OK, sp.ok.split("=")[0]!, "操作完成。")}
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
            ...(size !== 20 ? { size: String(size) } : {}),
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
          {items.map((item) => (
            <ContentRow key={item.postId} item={item} back={baseQuery({})} />
          ))}
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

      <AdminListPager
        total={total}
        page={safePage}
        totalPages={totalPages}
        basePath={baseQuery({})}
        controls={{ action: "/admin/contents", current: query, size }}
      />
    </div>
  );
}
