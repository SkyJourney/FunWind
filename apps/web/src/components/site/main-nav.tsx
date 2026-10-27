"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export interface NavLink {
  label: string;
  href: string;
  /** 仅路径完全一致时高亮（首页等根路径） */
  exact?: boolean;
}

/**
 * 主导航：当前页高亮（aria-current）。高亮按路径段匹配（/f/2 不会误中 /f/25）。
 * 由宿主控制显隐（桌面顶栏横向 / 其它壳复用时自行布局）。
 */
export function MainNav({ items, className }: { items: NavLink[]; className?: string }) {
  const pathname = usePathname();
  return (
    <nav className={cn("items-center gap-1 text-sm", className)} aria-label="站点导航">
      {items.map((item) => {
        const active = item.exact
          ? pathname === item.href
          : pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={`${item.label}:${item.href}`}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-md px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              active && "bg-accent font-medium text-foreground",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
