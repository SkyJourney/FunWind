"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowLeft,
  Award,
  BarChart3,
  ClipboardCheck,
  Coins,
  Flag,
  LayoutDashboard,
  Megaphone,
  Menu,
  MessageCircleWarning,
  ScrollText,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface AdminNavItem {
  href: string;
  label: string;
}

export interface AdminNavGroup {
  label: string;
  items: AdminNavItem[];
}

const ICON_BY_HREF: Record<string, LucideIcon> = {
  "/admin/dashboard": LayoutDashboard,
  "/admin/review": ClipboardCheck,
  "/admin/reports": Flag,
  "/admin/poll": BarChart3,
  "/admin/pm": MessageCircleWarning,
  "/admin/users": Users,
  "/admin/authz": ShieldCheck,
  "/admin/announcements": Megaphone,
  "/admin/points": Coins,
  "/admin/badges": Award,
  "/admin/logs": ScrollText,
};

/**
 * 后台布局壳（M9.5）：桌面（≥lg）= 前台顶栏下方全高固定侧栏（bg-card + 边框，独立滚动）；
 * 平板/手机（<lg）= 顶栏汉堡抽屉。内容区 lg:pl-56 让位侧栏，内层 max-w-5xl 控行宽。
 * 菜单项由服务端按权限过滤后传入，这里只负责渲染与当前态；
 * 二级页（users/[uid]、authz/* 等）的父项随路径前缀一并高亮。
 */
export function AdminShell({
  groups,
  children,
}: {
  groups: AdminNavGroup[];
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  const nav = (
    <nav aria-label="后台导航" className="flex-1 space-y-5 overflow-y-auto px-2">
      {groups.map((group) => (
        <div key={group.label}>
          <p className="mb-1 px-2 text-xs font-medium tracking-wide text-muted-foreground">
            {group.label}
          </p>
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const Icon = ICON_BY_HREF[item.href] ?? ClipboardCheck;
              const active = isActive(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "relative flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                      // 激活态：左侧主色竖线 + accent 底
                      "before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:bg-primary before:content-['']",
                      active ? "bg-accent font-medium text-foreground" : "before:opacity-0",
                    )}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );

  /** 侧栏与抽屉共用的导航体：站点名置顶 + 导航 + 底部返回社区 */
  const navBody = (
    <div className="flex h-full flex-col">
      <p className="px-4 pt-4 pb-3 text-sm font-semibold tracking-tight">清风社区 · 后台管理</p>
      {nav}
      <div className="px-4 pt-2 pb-4">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-primary"
        >
          <ArrowLeft className="size-3.5" aria-hidden /> 返回社区
        </Link>
      </div>
    </div>
  );

  return (
    <>
      {/* 桌面侧栏：从前台顶栏（sticky，md 起 h-14）下沿固定到页底 */}
      <aside className="fixed top-14 bottom-0 left-0 hidden w-56 border-r bg-card lg:flex lg:flex-col">
        {navBody}
      </aside>

      {/* 内容区：lg 起让位侧栏宽度 */}
      <div className="lg:pl-56">
        <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
          <header className="mb-5 flex items-center justify-between gap-3">
            <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
              {/* 平板/手机：汉堡抽屉 */}
              <span className="lg:hidden">
                <Sheet>
                  <SheetTrigger asChild>
                    <Button variant="outline" size="icon-sm" aria-label="后台菜单">
                      <Menu className="size-4" aria-hidden />
                    </Button>
                  </SheetTrigger>
                  <SheetContent side="left" className="w-64 overflow-y-auto">
                    <SheetTitle className="sr-only">后台导航</SheetTitle>
                    <div className="h-full pb-6">{navBody}</div>
                  </SheetContent>
                </Sheet>
              </span>
              后台管理
            </h1>
            <Link
              href="/"
              className="text-sm text-muted-foreground transition-colors hover:text-primary lg:hidden"
            >
              返回社区
            </Link>
          </header>
          {children}
        </div>
      </div>
    </>
  );
}
