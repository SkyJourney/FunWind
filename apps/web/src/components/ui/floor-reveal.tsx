"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";

type RevealState = "direct" | "pending" | "fade";

/**
 * 楼层滚入显影（M16 Step 4，docs/motion-spec.md §6.3 onInView 消费），三态：
 * - direct：首屏视口内（含贴着折叠线的楼层）或 IO 不可用——直出不播动画，MotionList
 *   注入的 fw-enter 错落照常（direct 不挂 fw-fade-in，两者不会同元素竞争 CSS 声明序）；
 * - pending：挂载时完全在视口外——opacity-0 挂起；
 * - fade：滚入触发区（视口底缘收窄 80px）后 fw-fade-in 淡入一次，永久显影、滚出不回退。
 *
 * 分类在 IO 首次回调完成（observe 即回报当下相交状态）：相交=已在触发区→保持直出；
 * 不相交但本体已入可视视口（折叠线楼层）→也保持直出，避免加载首帧「闪现→消失→再淡入」；
 * 完全在视口外→挂起，此后首次相交→fade 并停止观察（单向）。
 * setState 全部发生在 IO 订阅回调内；SSR 与首帧一律直出（无水合 mismatch、不推迟 LCP、
 * 无 JS 环境也可读全文）；挂起类施加时楼层仍在视口外，用户不可见、无闪烁窗口。
 * className / style 透传给包裹层——MotionList 注入的错落类与延迟经此生效；
 * 楼层锚点 id/scroll-mt 由调用方在内层元素继续持有。
 * reduce 下 fw-fade-in 被 globals.css 归零（滚入直接显现）。
 */
export function FloorReveal({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<RevealState>("direct");

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return; // 无 IO：保持直出
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          // 首回调相交=首屏楼层（保持直出）；pending 后相交=滚入触发区→淡入（单向显影）
          setState((s) => (s === "pending" ? "fade" : s));
          io.disconnect();
          return;
        }
        // 折叠线楼层（本体已入视口、尚未进触发区）保持直出；完全在视口外才挂起
        const rect = el.getBoundingClientRect();
        if (rect.top < window.innerHeight && rect.bottom > 0) io.disconnect();
        else setState("pending");
      },
      { rootMargin: "0px 0px -80px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const extra = state === "fade" ? "fw-fade-in" : state === "pending" ? "opacity-0" : "";

  return (
    <div ref={ref} className={cn(className, extra)} style={style}>
      {children}
    </div>
  );
}
