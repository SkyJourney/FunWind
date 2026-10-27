"use client";

import { useEffect } from "react";
import { kindBetween, setNavKind } from "@/lib/motion/nav-kind";

/**
 * 全局导航方向捕获（S5-C）：capture 阶段监听内部链接点击，按层级表写入 push/pop；
 * 浏览器返回/前进一律按 pop 处理（BFCache 之外的普通回退）。渲染 null，纯副作用层。
 */
export function NavKindCapture() {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
        return;
      const a = (e.target as HTMLElement | null)?.closest("a");
      if (!a) return;
      const href = a.getAttribute("href");
      if (!href || !href.startsWith("/") || a.target === "_blank" || a.hasAttribute("download"))
        return;
      setNavKind(kindBetween(window.location.pathname, a.pathname));
    };
    const onPop = () => setNavKind("pop");
    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", onPop);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", onPop);
    };
  }, []);
  return null;
}
