"use client";

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

type RevealState = "initial" | "direct" | "pending" | "fade";

/** 水合前 false、水合后 true（无 setState-in-effect 的 mounted 检测，theme-menu 同款） */
function useMounted(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

/**
 * 楼层滚入显影（M16 Step 4，docs/motion-spec.md §6.3 onInView 消费）：
 * - 挂载时在首屏视口内：direct——直接渲染不播动画（MotionList 对前 10 层注入的错落照常）；
 * - 挂载时在视口外：pending（opacity-0 隐藏），IO 首次滚入 → fade（fw-fade-in 淡入一次）；
 * - 状态驱动渲染：显隐类出自 React 输出——流式 RSC 重渲染不会抹掉手动加的类
 *   （与 draft.ts / hidden field 的「React 重渲染覆盖手动 DOM」同源教训）。
 * SSR / 首次客户端渲染不输出隐藏类（SSR 无法测位置；视口外楼层本不可见，无 CLS、无闪烁）；
 * reduce 下 fw-fade-in 被 globals.css 归零（直接显示）；IO 不可用时全部直出。
 * className / style 透传给包裹层——MotionList 注入的 fw-enter 错落类与延迟经此生效，
 * 楼层锚点 id/scroll-mt 由调用方在内层元素继续持有。
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
  const mounted = useMounted();
  const [state, setState] = useState<RevealState>("initial");

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setState("direct"); // 无 IO：直出
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        // 单向显影：首次相交即 fade 并停止观察——滚出视口后不得回退成隐藏
        if (entries.some((e) => e.isIntersecting)) {
          setState("fade");
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -80px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const extra = !mounted
    ? ""
    : state === "fade"
      ? "fw-fade-in"
      : state === "pending"
        ? "opacity-0"
        : "";

  return (
    <div ref={ref} className={cn(className, extra)} style={style}>
      {children}
    </div>
  );
}
