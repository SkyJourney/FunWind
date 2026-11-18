"use client";

import { usePathname } from "next/navigation";

/**
 * 前台壳抑制门（M20.1）：独立文档路由（/docs/**）不套前台形态——
 * 顶栏 / 公告横幅 / 底部 Tab / 页脚等前台视觉壳在此前缀下整体收起，
 * 页面自备独立文档站壳（app/docs/layout.tsx）。根 layout 把各壳包进本门即可，逐组件零侵入。
 */
export function ChromeGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname === "/docs" || pathname.startsWith("/docs/")) return null;
  return <>{children}</>;
}
