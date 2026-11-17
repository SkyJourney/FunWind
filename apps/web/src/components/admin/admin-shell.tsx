"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowLeft, ClipboardCheck, Menu } from "lucide-react";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { PageMotionBoundary } from "@/components/site/page-motion-boundary";
import { ICON_BY_HREF } from "@/components/admin/admin-nav-icons";
import { cn } from "@/lib/utils";

export interface AdminNavItem {
  href: string;
  label: string;
}

export interface AdminNavGroup {
  label: string;
  items: AdminNavItem[];
}

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
  /** 移动端抽屉开合（受控）：导航项点击即关 + 路由变化兜底关（桌面侧栏不受影响） */
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // Radix Dialog 不感知 Next 软导航：受控 onClick 关闭在软导航并发更新下被吞（M20.1 实测），
  // 以路由变化为本源兜底——点导航/浏览器返回/任何软导航都触发 pathname 变化 → 关抽屉
  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  const nav = (onNavigate?: () => void) => (
    <nav aria-label="后台导航" className="min-h-0 flex-1 space-y-5 overflow-y-auto px-2">
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
                    onClick={onNavigate}
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

  /** 侧栏与抽屉共用的导航体：站点名置顶 + 导航 + 底部返回社区；onNavigate 供抽屉导航后关闭 */
  const navBody = (onNavigate?: () => void) => (
    <div className="flex h-full flex-col">
      <p className="px-4 pt-4 pb-3 text-sm font-semibold tracking-tight">清风社区 · 后台管理</p>
      {nav(onNavigate)}
      <div className="shrink-0 border-t bg-card px-4 pt-2 pb-4">
        <Link
          href="/"
          onClick={onNavigate}
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
        {navBody()}
      </aside>

      {/* 内容区：lg 起让位侧栏宽度 */}
      <div className="lg:pl-56">
        <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
          <header className="mb-5 flex items-center justify-between gap-3">
            <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
              {/* 平板/手机：汉堡抽屉 */}
              <span className="lg:hidden">
                {/* 受控（M20.1 修复）：Radix Sheet 不感知 Next 软导航——非受控时点导航项
                    页面已切换而抽屉不关，内容 fade 在 overlay 下被遮成「闪一下」。 */}
                <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
                  <SheetTrigger asChild>
                    <Button variant="outline" size="icon-sm" aria-label="后台菜单">
                      <Menu className="size-4" aria-hidden />
                    </Button>
                  </SheetTrigger>
                  <SheetContent side="left" className="w-64 overflow-y-auto">
                    <SheetTitle className="sr-only">后台导航</SheetTitle>
                    <div className="min-h-0 flex-1 pb-6">
                      {navBody(() => setMobileNavOpen(false))}
                    </div>
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
          {/* 页面层 keyed VT 边界：组内切换 fade 微动，侧栏/头部/抽屉在边界外静止不重挂（M15 Step 4） */}
          <PageMotionBoundary>{children}</PageMotionBoundary>
        </div>
      </div>
    </>
  );
}
