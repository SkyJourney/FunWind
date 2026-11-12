"use client";

import { useEffect, useRef, useState, type ImgHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type RevealState = "hidden" | "fading" | "shown";

/**
 * 图片显影（M16 Step 3，docs/motion-spec.md §6.3）：占位底色 + onLoad 淡入。
 *
 * - 默认 `loading="lazy"` 且加载完成前 opacity-0（bg-muted 占位底色透出），onLoad 后挂
 *   fw-fade-in 淡入一次；reduce 下被 globals.css 归零（直接显示）；
 * - **首屏 LCP 豁免（`eager`）**：Step 0 实验③实证淡入会推迟 LCP（≈过渡时长），可能成为
 *   LCP 元素的首屏图片必须传 `eager`——直接渲染、立即可见、不懒加载、无任何显影类；
 * - 缓存命中时 load 事件早于 React 挂监听：挂载后检查 `complete` 直接显示（不播动画）；
 *   加载失败也直接显示（露出 alt/破图态，不无限隐藏）。
 * 其余属性（className 等）透传给 img；调用方负责尺寸类（aspect/object-cover）。
 */
export function FadeImage({
  src,
  alt,
  className,
  eager = false,
  ...rest
}: ImgHTMLAttributes<HTMLImageElement> & {
  src: string;
  alt: string;
  /** 首屏 LCP 豁免：true 时不懒加载、无任何显影类，直接渲染 */
  eager?: boolean;
}) {
  const ref = useRef<HTMLImageElement>(null);
  // eager：恒 shown（不进状态机）；非 eager：hidden →（load）→ fading →（动画由 CSS 收尾）
  const [state, setState] = useState<RevealState>(eager ? "shown" : "hidden");

  useEffect(() => {
    if (eager) return;
    // 缓存命中：load 事件已错过——直接显示，不播动画
    if (ref.current?.complete) setState("shown");
  }, [eager]);

  const markSettled = () => setState((s) => (s === "hidden" ? "shown" : s));

  const extra = eager
    ? ""
    : state === "hidden"
      ? "opacity-0"
      : state === "fading"
        ? "fw-fade-in"
        : "";

  return (
    // eslint-disable-next-line @next/next/no-img-element -- 内容图与正文管线同口径（/files 与旧站外链），不走 next/image 优化域
    <img
      ref={ref}
      src={src}
      alt={alt}
      loading={eager ? undefined : "lazy"}
      onLoad={() => setState((s) => (s === "hidden" ? "fading" : s))}
      onError={markSettled} // 失败也显示（露出 alt/破图态，不无限隐藏）
      className={cn("bg-muted", className, extra)}
      {...rest}
    />
  );
}
