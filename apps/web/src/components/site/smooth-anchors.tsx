"use client";

import { useEffect } from "react";
import { pinScrollAtCurrent } from "./scroll-record";

/**
 * 页内锚点平滑滚动（M16 Step 4，docs/motion-spec.md §6.3）：
 * 拦截同页 hash 链接点击（如楼层「回复 #N」/「去回复」），preventDefault 后平滑滚到目标并
 * 以 pushState 写入同地址 + hash（与浏览器默认锚点行为等价）。
 * 点击前先钉住滚动存档（scroll-record.pinScrollAtCurrent）：平滑滚动的每一帧都会触发持续
 * 采集，不先钉住的话「点击前位置」会被刷成锚点位置——从锚点历史项返回时应回到点击前位置
 * （浏览器原生语义）；同页历史往返由 NavKindCapture 的同页守卫接管：不播动效、不强制恢复。
 * 深链直开（加载自带 hash）保持浏览器瞬时跳转；:target 高亮由 CSS 接管；
 * reduce 下 scrollIntoView 显式传 behavior auto（瞬时跳转），且不挂高亮类。
 * 高亮 timer 持句柄：连点同目标先清旧再挂新（旧 timer 不得提前掐断新高亮），卸载清理。
 */
export function SmoothAnchors() {
  useEffect(() => {
    const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let hlTimer: number | undefined;
    const onClick = (raw: Event) => {
      const anchor = (raw.target as Element | null)?.closest?.("a[href]");
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (!href.startsWith("#") || href.length < 2) return;
      const target = document.getElementById(href.slice(1));
      if (!target) return;
      raw.preventDefault();
      pinScrollAtCurrent();
      target.scrollIntoView({
        behavior: reduced() ? "auto" : "smooth",
        block: "start",
      });
      window.history.pushState(null, "", href);
      // 高亮：pushState 不会触发 Chromium 的 :target 激活（仅真实片段导航会）——
      // 点击路径由 JS 挂临时高亮类（深链直开仍走 :target CSS 规则）；reduce 不挂。
      if (!reduced()) {
        window.clearTimeout(hlTimer);
        target.classList.add("fw-floor-hl-on");
        hlTimer = window.setTimeout(() => target.classList.remove("fw-floor-hl-on"), 2100);
      }
    };
    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.clearTimeout(hlTimer);
    };
  }, []);
  return null;
}
