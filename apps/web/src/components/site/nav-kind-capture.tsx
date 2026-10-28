"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { kindBetween, setNavKind } from "@/lib/motion/nav-kind";

/**
 * 浏览器前进 / 后退（popstate）的方向捕获（M10.7 Step 4b）：popstate 不带过渡类型，
 * 这里按当前位置与目标的层级判定，写到 <html data-nav>。
 * 点击发起的导航不在这里处理——由导航守卫（navigation-guard.tsx）在确认发起导航时写方向，
 * 避免「守卫拦下了重复点击而方向已经写了」的错向残留。渲染 null，纯副作用层。
 */
export function NavKindCapture() {
  const pathname = usePathname();
  const currentPath = useRef(pathname);
  useEffect(() => {
    currentPath.current = pathname;
  }, [pathname]);
  useEffect(() => {
    const onPop = () => setNavKind(kindBetween(currentPath.current, window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return null;
}
