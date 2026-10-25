"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";

/**
 * 公告横幅（M9）：show_banner=true 且当前有效的公告取最新一条；游客与会员都可见（audience 过滤在服务端）。
 * 关闭记忆走 localStorage（游客无已读状态——docs/NOTIFICATIONS.md §3）；登录用户的未读计数在铃铛侧。
 */

interface BannerAnnouncement {
  id: number;
  title: string;
  level: "info" | "important";
}

const DISMISS_KEY = "fw-banner-dismissed";

export function AnnouncementBanner({ banner }: { banner: BannerAnnouncement | null }) {
  const [dismissed, setDismissed] = useState(true); // SSR 首渲染不弹（避免水合不一致），挂载后查记忆

  useEffect(() => {
    if (!banner) return;
    // 挂载后宏任务读取 localStorage（effect 体内直呼 setState 会触发级联渲染 lint）
    const kick = setTimeout(() => {
      try {
        setDismissed(window.localStorage.getItem(`${DISMISS_KEY}:${banner.id}`) === "1");
      } catch {
        setDismissed(false); // 存储不可用：显示（宁可多显示不漏公告）
      }
    }, 0);
    return () => clearTimeout(kick);
  }, [banner]);

  if (!banner || dismissed) return null;

  return (
    <div
      role="status"
      data-testid="announcement-banner"
      className={`flex items-center justify-center gap-2 px-4 py-2 text-sm ${
        banner.level === "important"
          ? "bg-destructive/10 text-destructive"
          : "bg-accent text-accent-foreground"
      }`}
    >
      <span className="truncate">📢 {banner.title}</span>
      <button
        type="button"
        aria-label="关闭公告横幅"
        className="shrink-0 text-muted-foreground hover:text-foreground"
        onClick={() => {
          setDismissed(true);
          try {
            window.localStorage.setItem(`${DISMISS_KEY}:${banner.id}`, "1");
          } catch {
            // 存储不可用：仅本次关闭
          }
        }}
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
