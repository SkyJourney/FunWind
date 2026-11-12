"use client";

import { useEffect, useState } from "react";
import { ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 回到顶部（M16 Step 4，docs/motion-spec.md §6.3）：滚动超过一屏后出现在桌面右下。
 * 移动端不参与（底部 Tab 栏占位、ReplyFab 在同位置）：base hidden，display 恒不切换。
 * 点击平滑回顶；reduce 下瞬时跳转。
 * 显隐走 ReplyFab 同款口径（motion-spec §6.3）：按钮常驻渲染，只动 transform / opacity
 * （display 切换没有过渡起始态会让过渡失效，故桌面恒 md:flex）；隐藏态 opacity-0 +
 * translate-y-2 + pointer-events-none + inert + aria-hidden（不可见即不可点、不可聚焦、
 * 不被读屏读到）。显隐时长走动效令牌，reduce 下无过渡（直接显隐）。
 */
export function BackToTop() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > window.innerHeight);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <button
      type="button"
      aria-label="回到顶部"
      title="回到顶部"
      onClick={() =>
        window.scrollTo({
          top: 0,
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth",
        })
      }
      inert={!show}
      aria-hidden={!show}
      className={cn(
        "fixed right-4 bottom-[calc(3.5rem+env(safe-area-inset-bottom)+1rem)] z-30 hidden size-10 items-center justify-center rounded-full border bg-card text-muted-foreground shadow-2 transition-[transform,opacity] duration-base ease-out-soft hover:text-primary active:scale-95 motion-reduce:transition-none md:flex",
        show ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-2 opacity-0",
      )}
    >
      <ArrowUp className="size-4" aria-hidden />
    </button>
  );
}
