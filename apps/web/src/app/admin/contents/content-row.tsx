import Link from "next/link";
import { fmtDateTime } from "@/lib/admin/format";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { restorePostAction } from "@/app/actions/posts";
import type { ContentListItem } from "@/lib/moderation/contents";
import {
  approveContentAction,
  disableContentAction,
  hideContentAction,
  purgeContentAction,
  rejectContentAction,
  threadFlagsAction,
} from "./actions";

export const STATE_BADGE: Record<string, { text: string; cls: string }> = {
  visible: { text: "正常", cls: "bg-success/10 text-success" },
  pending: { text: "待审核", cls: "bg-warning/10 text-warning" },
  rejected: { text: "已驳回", cls: "bg-destructive/10 text-destructive" },
  hidden: { text: "已屏蔽", cls: "bg-muted text-muted-foreground" },
  disabled: { text: "已封禁", cls: "bg-destructive/10 text-destructive" },
  deleted: { text: "已删除", cls: "bg-muted text-muted-foreground" },
};

/**
 * 内容管理行卡片（M19 自 page.tsx 迁出以控行数）：内容渲染在上、管理交互整行沉底；
 * 待审核行左侧批量勾选经 form 属性关联页底 bulk-contents-form；back 保留当前筛选。
 */
export function ContentRow({ item, back }: { item: ContentListItem; back: string }) {
  const badge = STATE_BADGE[item.state] ?? { text: item.state, cls: "bg-muted" };
  return (
    <li className="rounded-xl border bg-card px-4 py-3">
      {/* 纵向统一排版（站长定稿）：内容渲染在上、管理交互整行沉底——
                主题/回帖长度差异不影响操作区位置，多断点下排版一致；
                待审核行左侧加批量勾选（form 属性关联页底批量条，HTML 禁止嵌套 form） */}
      <div className={`min-w-0 ${item.state === "pending" ? "flex items-start gap-2" : ""}`}>
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
            <span className={`ml-2 rounded px-1.5 py-0.5 text-xs ${badge.cls}`}>{badge.text}</span>
            {item.authorBanned && (
              <span className="ml-1 rounded bg-warning/10 px-1.5 py-0.5 text-xs text-warning">
                作者已封禁
              </span>
            )}
          </p>
          {item.excerpt && (
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{item.excerpt}</p>
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
      </div>

      {/* 管理交互行（统一沉底）：按当前状态给出可用动作 */}
      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t pt-2.5">
        {item.state === "pending" && (
          <>
            <form action={approveContentAction}>
              <input type="hidden" name="postId" value={item.postId} />
              <input type="hidden" name="back" value={back} />
              <button
                type="submit"
                className="rounded-lg border px-2.5 py-1 text-xs hover:bg-accent"
              >
                通过
              </button>
            </form>
            <form action={rejectContentAction} className="flex items-center gap-1">
              <input type="hidden" name="postId" value={item.postId} />
              <input type="hidden" name="back" value={back} />
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
            <input type="hidden" name="back" value={back} />
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
            <input type="hidden" name="back" value={back} />
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
            <button type="submit" className="rounded-lg border px-2 py-0.5 text-xs hover:bg-accent">
              应用
            </button>
          </form>
        )}
      </div>
    </li>
  );
}
