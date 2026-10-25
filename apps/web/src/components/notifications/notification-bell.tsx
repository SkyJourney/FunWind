"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { renderNotification } from "@/lib/notifications/render";

/**
 * 顶栏铃铛（M8，客户端岛）：挂载与窗口重新聚焦时拉取 /api/notifications/bell；
 * 不做实时推送（docs/NOTIFICATIONS.md §6）。模块停用时由宿主（layout）不渲染。
 */

interface BellItem {
  kind: "notification" | "announcement";
  id: number;
  category: string;
  type: string;
  actorName: string | null;
  createdAt: string;
  data: Record<string, unknown> | null;
  title?: string;
}

interface BellData {
  unread: {
    interaction: number;
    message: number;
    moderation: number;
    account: number;
    announcement: number;
    total: number;
  };
  recent: BellItem[];
}

const CATEGORY_NAMES: Record<string, string> = {
  interaction: "互动",
  message: "私信",
  moderation: "审核",
  account: "账号",
  announcement: "公告",
};

export function NotificationBell() {
  const [data, setData] = useState<BellData | null>(null);
  const [open, setOpen] = useState(false);
  const fetching = useRef(false);

  const refresh = useCallback(async () => {
    if (fetching.current) return;
    fetching.current = true;
    try {
      const res = await fetch("/api/notifications/bell", { credentials: "same-origin" });
      if (res.ok) setData((await res.json()) as BellData);
    } catch {
      // 拉取失败静默：铃铛是增强功能，不阻塞页面
    } finally {
      fetching.current = false;
    }
  }, []);

  useEffect(() => {
    // 首次拉取延后到宏任务：effect 体内直呼会触发 setState-in-effect 级联渲染
    const kick = setTimeout(() => void refresh(), 0);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(kick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const markAllRead = async () => {
    try {
      await fetch("/api/notifications/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ all: true }),
      });
      await refresh();
    } catch {
      // 同上：静默
    }
  };

  const total = data?.unread.total ?? 0;

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) void refresh();
      }}
    >
      <DropdownMenuTrigger
        aria-label={`通知（未读 ${total}）`}
        className="relative inline-flex items-center rounded-md p-1 text-muted-foreground hover:text-foreground"
      >
        <Bell className="size-4" />
        {total > 0 && (
          <span
            data-testid="bell-unread"
            className="absolute -top-1 -right-1 inline-flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-4 font-medium text-primary-foreground"
          >
            {total > 99 ? "99+" : total}
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="flex items-center justify-between">
          <span>通知{total > 0 ? `（${total} 未读）` : ""}</span>
          {total > 0 && (
            <button
              type="button"
              onClick={() => void markAllRead()}
              className="text-xs text-primary hover:underline"
            >
              全部已读
            </button>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {(data?.recent.length ?? 0) === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">没有未读通知</p>
        ) : (
          data!.recent.map((item) => {
            const rendered =
              item.kind === "announcement"
                ? { label: `公告：${item.title ?? ""}`, categoryLabel: "公告" }
                : renderNotification(item.type, item.data, item.actorName);
            return (
              <DropdownMenuItem
                key={`${item.kind}:${item.id}`}
                className="flex-col items-start gap-0.5"
              >
                <span className="text-xs text-muted-foreground">
                  {CATEGORY_NAMES[item.category] ?? item.category}
                </span>
                <span className="line-clamp-2 text-sm">{rendered?.label ?? item.type}</span>
              </DropdownMenuItem>
            );
          })
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/notifications" className="w-full text-center text-sm text-primary">
            查看全部
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
