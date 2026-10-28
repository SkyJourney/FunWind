"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { markOneReadAction } from "@/app/actions/notifications";
import type { NotificationRowData } from "@/lib/notifications/row";

/**
 * 通知行（/notifications）：首屏与流式追加项共用。
 * 「已读」保持为表单（Server Action）——无 JS 时仍是整页提交 + 重定向；有 JS 时拦截提交，
 * 走 /api/notifications/read 就地标记，不跳转，已追加的列表不丢（M10.7 站长拍板）。
 * 成功后 router.refresh() 刷新顶部「未读 N」与分类计数；公告的「已读」语义是读全部公告，
 * 其它公告行在刷新后随服务端数据更新（已追加的公告行保持原样直到下次进入页面）。
 */
export function NotificationRow({
  row,
  backHref,
  className,
  style,
}: {
  row: NotificationRowData;
  /** 无 JS 回退时重定向的页面（带分类参数） */
  backHref: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const router = useRouter();
  const [markedRead, setMarkedRead] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const unread = !row.read && !markedRead;

  async function markRead() {
    setPending(true);
    setFailed(false);
    try {
      const res = await fetch("/api/notifications/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(
          row.kind === "announcement" ? { category: "announcement" } : { ids: [row.id] },
        ),
      });
      if (!res.ok) throw new Error(`read ${res.status}`);
      setMarkedRead(true);
      router.refresh();
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <li
      className={`flex items-start gap-2.5 rounded-xl border bg-card px-4 py-3 ${unread ? "" : "opacity-70"}${className ? ` ${className}` : ""}`}
      style={style}
    >
      <span
        aria-hidden
        className={`mt-2.5 size-2 shrink-0 rounded-full ${unread ? "bg-primary" : "bg-transparent"}`}
      />
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">
          {row.categoryLabel} · {row.createdAt}
        </p>
        <p className={`mt-0.5 text-sm ${unread ? "font-medium" : ""}`}>
          {row.conversationId !== null ? (
            <Link href={`/messages/${row.conversationId}`} className="hover:text-primary">
              {row.label}
            </Link>
          ) : (
            row.label
          )}
          {row.groupCount !== null && (
            <span className="ml-1 text-xs text-primary">（{row.groupCount} 条）</span>
          )}
        </p>
        {row.bodyMd && (
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{row.bodyMd}</p>
        )}
      </div>
      {unread && (
        <form
          action={markOneReadAction}
          className="shrink-0"
          onSubmit={(e) => {
            // 有 JS：就地标记；无 JS 时这个处理器不存在，表单照常提交给 Server Action
            e.preventDefault();
            if (!pending) void markRead();
          }}
        >
          <input type="hidden" name="kind" value={row.kind} />
          <input type="hidden" name="id" value={row.id} />
          <input type="hidden" name="back" value={backHref} />
          <button
            type="submit"
            disabled={pending}
            className="text-xs text-primary hover:underline disabled:opacity-60"
          >
            {failed ? "失败，重试" : row.kind === "announcement" ? "标记所有公告已读" : "已读"}
          </button>
        </form>
      )}
    </li>
  );
}
