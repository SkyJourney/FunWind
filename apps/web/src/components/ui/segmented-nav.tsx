"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

export interface SegmentedItem {
  key: string;
  href: string;
  label: ReactNode;
}

/**
 * 分段控件（链接形态，M10.7 Step 5c，S4 §3.1「Tab 滑动指示器」）：个人主页「主题 / 回复」等。
 * 各格等宽，高亮块是一个独立的指示器，用 translateX 在格子之间滑动（spring 过冲）——只动 transform；
 * 它在同一个客户端组件里持续存在，所以仅查询串变化的切换（页面不重挂载）能看到滑动。
 * 点击即移动（不等服务端返回新页面）：`clicked` 记录点击的格子；真实 activeKey 一变（导航提交）就在渲染期清掉它
 * （React 推荐的「根据上一次的 prop 重置 state」写法，不需要 effect）——不能只靠比较「点击时的 activeKey」，
 * 否则点了「回复」导航提交后，浏览器返回使 activeKey 又变回点击前的值，陈旧的点击记录会重新生效、劫持指示器。
 * 导航失败时指示器停在点击处，由失败 toast 提示。
 * 语义仍是链接（aria-current），无 JS 时指示器按服务端给的 activeKey 静态定位。
 */
export function SegmentedNav({
  items,
  activeKey,
  ariaLabel,
  className,
}: {
  items: SegmentedItem[];
  activeKey: string;
  ariaLabel: string;
  className?: string;
}) {
  const [clicked, setClicked] = useState<string | null>(null);
  const [lastActive, setLastActive] = useState(activeKey);
  if (lastActive !== activeKey) {
    setLastActive(activeKey);
    setClicked(null);
  }
  const shownKey = clicked ?? activeKey;
  const index = Math.max(
    0,
    items.findIndex((i) => i.key === shownKey),
  );
  const n = items.length;
  const gap = 0.125; // gap-0.5，rem
  const pad = 0.125; // p-0.5，rem

  return (
    <nav
      aria-label={ariaLabel}
      className={cn("relative flex gap-0.5 rounded-lg bg-muted p-0.5 text-sm", className)}
    >
      {/* 指示器：宽度 = (容器 − 两侧内边距 − 间隙) / n；位移 = index × (自身宽度 + 间隙) */}
      <span
        aria-hidden
        data-testid="segmented-indicator"
        className="absolute inset-y-0.5 left-0.5 rounded-md bg-card shadow-1 transition-transform duration-spring ease-spring"
        style={{
          width: `calc((100% - ${pad * 2}rem - ${(n - 1) * gap}rem) / ${n})`,
          transform: `translateX(calc(${index} * (100% + ${gap}rem)))`,
        }}
      />
      {items.map((item) => (
        <Link
          key={item.key}
          href={item.href}
          aria-current={item.key === activeKey ? "page" : undefined}
          onClick={() => setClicked(item.key)}
          className={cn(
            "relative z-10 flex-1 rounded-md px-3 py-1.5 text-center transition-colors duration-fast",
            item.key === shownKey ? "font-semibold text-foreground" : "text-muted-foreground",
          )}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
