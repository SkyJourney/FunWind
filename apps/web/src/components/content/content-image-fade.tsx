"use client";

import { useEffect } from "react";

/**
 * 正文图片显影委托（M16 Step 3）：正文经 dangerouslySetInnerHTML 渲染，无法逐图挂
 * React onLoad——本组件（每个 RichContent 挂一个，幂等）自发现页面上未处理的
 * .content-md 容器并委托处理视口外图片的懒加载与淡入。
 *
 * - 缓存已加载（complete）：不动，保持原样（无闪烁）；
 * - 首屏视口内：不动（LCP 豁免——Step 0 实验③：淡入会推迟 LCP ≈ 过渡时长）；
 * - 视口外：置 loading=lazy + 挂 fw-img-fade（未加载隐藏 / load 后过渡显影）；
 *   StrictMode/重复执行以容器 data 标记幂等。
 *
 * CSS 侧（globals.css）：fw-img-fade 未 fw-img-loaded 时 opacity 0；loaded 后过渡显影；
 * fw-img-fade 的过渡在 reduce 下由 fw-img-fade 自带媒体查询归零（不依赖动画兜底规则）。
 */
export function ContentImageFade() {
  useEffect(() => {
    const containers = document.querySelectorAll(".content-md:not([data-fw-img-fade])");
    for (const root of containers) {
      root.setAttribute("data-fw-img-fade", "1");
      for (const img of Array.from(root.querySelectorAll("img"))) {
        if (img.dataset.fwImgFade !== undefined) continue; // 幂等
        img.dataset.fwImgFade = "1";
        if (img.complete) continue; // 缓存已加载：直接可见
        const rect = img.getBoundingClientRect();
        if (rect.top < window.innerHeight && rect.bottom > 0) continue; // 首屏视口内：LCP 豁免
        img.loading = "lazy";
        img.classList.add("fw-img-fade");
        const reveal = () => img.classList.add("fw-img-loaded");
        if (img.complete) reveal();
        else {
          img.addEventListener("load", reveal, { once: true });
          img.addEventListener("error", reveal, { once: true });
        }
      }
    }
  }, []);
  return null;
}
