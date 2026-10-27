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
 * 后台布局壳（M10.5）：桌面 = 左侧分组侧栏（粘性）；移动 = 顶栏抽屉。
 * 菜单项由服务端按权限过滤后传入，这里只负责渲染与当前态。
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
    <nav aria-label="后台导航" className="space-y-5">
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
                      "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                      active && "bg-accent font-medium text-foreground",
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
      <div className="px-2 pt-2">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-primary"
        >
          <ArrowLeft className="size-3.5" aria-hidden /> 返回社区
        </Link>
      </div>
    </nav>
  );

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <div className="md:flex md:gap-8">
        <aside className="hidden w-48 shrink-0 md:block">
          <div className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto pb-4">{nav}</div>
        </aside>
        <div className="min-w-0 flex-1">
          <header className="mb-5 flex items-center justify-between gap-3">
            <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
              {/* 移动端：汉堡抽屉 */}
              <span className="md:hidden">
                <Sheet>
                  <SheetTrigger asChild>
                    <Button variant="outline" size="icon-sm" aria-label="后台菜单">
                      <Menu className="size-4" aria-hidden />
                    </Button>
                  </SheetTrigger>
                  <SheetContent side="left" className="w-64 overflow-y-auto">
                    <SheetTitle className="px-2">后台导航</SheetTitle>
                    <div className="pb-6">{nav}</div>
                  </SheetContent>
                </Sheet>
              </span>
              后台管理
            </h1>
            <Link
              href="/"
              className="text-sm text-muted-foreground transition-colors hover:text-primary md:hidden"
            >
              返回社区
            </Link>
          </header>
          {children}
        </div>
      </div>
    </div>
  );
}
