import Link from "next/link";
import type { ReactNode } from "react";

type AdminTab = { key: string; label: ReactNode; href: string };

/** 后台服务端页签：链接与激活项由页面决定，只复用既有导航的 DOM 与样式。 */
export function AdminTabs({
  tabs,
  activeKey,
  label,
  className = "flex gap-2 text-sm",
  linkClassName = "rounded-full border px-3 py-1",
}: {
  tabs: readonly AdminTab[];
  activeKey: string;
  label: string;
  className?: string;
  linkClassName?: string;
}) {
  return (
    <nav className={className} aria-label={label}>
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          className={`${linkClassName} transition-colors ${activeKey === tab.key ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
