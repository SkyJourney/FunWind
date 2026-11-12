"use client";

import { useEffect } from "react";

/**
 * 页内锚点平滑滚动（M16 Step 4，docs/motion-spec.md §6.3）：
 * 拦截同页 hash 链接点击（如楼层「回复 #N」/「去回复」），preventDefault 后平滑滚到目标并
 * 以 pushState 写入同地址 + hash（与浏览器默认锚点行为等价，但不产生多余历史项差异）。
 * 深链直开（加载自带 hash）保持浏览器瞬时跳转；:target 高亮由 CSS 接管；
 * reduce 下 scrollIntoView 的 behavior 由 CSS scroll-behavior 无关——这里显式传入，
 * reduce 检测走 matchMedia（瞬时跳转）。
 */
export function SmoothAnchors() {
  useEffect(() => {
    const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const onClick = (raw: Event) => {
      const anchor = (raw.target as Element | null)?.closest?.("a[href]");
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (!href.startsWith("#") || href.length < 2) return;
      const target = document.getElementById(href.slice(1));
      if (!target) return;
      raw.preventDefault();
      target.scrollIntoView({
        behavior: reduced() ? "auto" : "smooth",
        block: "start",
      });
      window.history.pushState(null, "", href);
      // 高亮：pushState 不会触发 Chromium 的 :target 激活（仅真实片段导航会）——
      // 点击路径由 JS 挂临时高亮类（深链直开仍走 :target CSS 规则）；reduce 不挂。
      if (!reduced()) {
        target.classList.add("fw-floor-hl-on");
        window.setTimeout(() => target.classList.remove("fw-floor-hl-on"), 2100);
      }
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);
  return null;
}
