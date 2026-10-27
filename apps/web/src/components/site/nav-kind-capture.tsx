"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { kindBetween, setNavKind } from "@/lib/motion/nav-kind";

/**
 * 全局导航方向捕获（S5-C）：capture 阶段监听内部链接点击，按层级表写入 push/pop；
 * 浏览器历史导航按当前位置与目标的层级判定。渲染 null，纯副作用层。
 */
export function NavKindCapture() {
  const pathname = usePathname();
  const currentPath = useRef(pathname);
  useEffect(() => {
    currentPath.current = pathname;
  }, [pathname]);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
        return;
      const a = (e.target as HTMLElement | null)?.closest("a");
      if (!a) return;
      const href = a.getAttribute("href");
      if (
        !href ||
        !href.startsWith("/") ||
        href.startsWith("//") ||
        (a.target && a.target !== "_self") ||
        a.hasAttribute("download")
      )
        return;
      if (a.pathname === window.location.pathname) return;
      setNavKind(kindBetween(window.location.pathname, a.pathname), a.pathname);
    };
    const onPop = () =>
      setNavKind(
        kindBetween(currentPath.current, window.location.pathname),
        window.location.pathname,
      );
    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", onPop);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", onPop);
    };
  }, []);
  return null;
}
