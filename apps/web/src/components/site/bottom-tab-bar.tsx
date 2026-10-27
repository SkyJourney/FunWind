"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  CircleUserRound,
  Home,
  LayoutGrid,
  LogIn,
  MessageCircle,
  PenLine,
  Search,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface Tab {
  href: string;
  label: string;
  icon: LucideIcon;
  /** 中央凸起的主行动样式（发帖） */
  raised?: boolean;
  badge?: number;
  isActive: (pathname: string) => boolean;
}

const seg = (base: string) => (p: string) => p === base || p.startsWith(`${base}/`);

/**
 * 移动端底部 Tab（<md）：首页/版块/发帖/消息/我的。
 * 低频入口聚合在用户菜单与「我的」目标页；游客降级为 首页/版块/搜索/登录。
 */
export function BottomTabBar({
  user,
  pmOn,
  pmUnread,
}: {
  user: { id: number } | null;
  pmOn: boolean;
  pmUnread: number;
}) {
  const tabs: Tab[] = user
    ? [
        { href: "/", label: "首页", icon: Home, isActive: (p) => p === "/" },
        {
          href: "/boards",
          label: "版块",
          icon: LayoutGrid,
          isActive: (p) => seg("/boards")(p) || seg("/f")(p),
        },
        {
          href: "/submit",
          label: "发帖",
          icon: PenLine,
          raised: true,
          isActive: (p) => seg("/submit")(p) || /^\/f\/\d+\/new/.test(p),
        },
        ...(pmOn
          ? [
              {
                href: "/messages",
                label: "消息",
                icon: MessageCircle,
                badge: pmUnread,
                isActive: seg("/messages"),
              },
            ]
          : []),
        {
          href: "/me",
          label: "我的",
          icon: CircleUserRound,
          isActive: (p) =>
            seg("/me")(p) || seg("/settings")(p) || seg("/points")(p) || seg("/u")(p),
        },
      ]
    : [
        { href: "/", label: "首页", icon: Home, isActive: (p) => p === "/" },
        {
          href: "/boards",
          label: "版块",
          icon: LayoutGrid,
          isActive: (p) => seg("/boards")(p) || seg("/f")(p),
        },
        { href: "/search", label: "搜索", icon: Search, isActive: seg("/search") },
        { href: "/login", label: "登录", icon: LogIn, isActive: seg("/login") },
      ];

  return (
    <nav
      aria-label="移动端主导航"
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
    >
      <ul className="flex h-14 items-stretch">
        {tabs.map((tab) => (
          <BottomTab key={tab.label} tab={tab} />
        ))}
      </ul>
    </nav>
  );
}

function BottomTab({ tab }: { tab: Tab }) {
  const pathname = usePathname();
  const active = tab.isActive(pathname);
  const Icon = tab.icon;
  return (
    <li className="flex-1">
      <Link
        href={tab.href}
        aria-current={active ? "page" : undefined}
        className={cn(
          "relative flex h-full flex-col items-center justify-center gap-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground",
          active && "text-primary",
        )}
      >
        {tab.raised ? (
          <span
            className={cn(
              "-mt-5 flex size-10 items-center justify-center rounded-full text-primary-foreground shadow-md",
              active ? "bg-primary" : "bg-primary/90",
            )}
          >
            <Icon className="size-5" aria-hidden />
          </span>
        ) : (
          <span className="relative">
            <Icon className="size-5" aria-hidden />
            {(tab.badge ?? 0) > 0 && (
              <span className="absolute -top-1 -right-2 inline-flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-4 font-medium text-primary-foreground">
                {(tab.badge ?? 0) > 99 ? "99+" : tab.badge}
              </span>
            )}
          </span>
        )}
        {tab.label}
      </Link>
    </li>
  );
}
