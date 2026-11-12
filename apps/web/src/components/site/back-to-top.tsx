"use client";

import { useEffect, useState } from "react";
import { ArrowUp } from "lucide-react";

/**
 * 回到顶部（M16 Step 4，docs/motion-spec.md §6.3）：滚动超过一屏后出现在桌面右下
 * （移动端底部 Tab 栏占位，隐藏）。点击平滑回顶；reduce 下瞬时跳转；
 * 隐藏/出现走 transform/opacity 过渡并带 motion-reduce:transition-none（ReplyFab 同款口径）。
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
      className={`fixed right-4 bottom-[calc(3.5rem+env(safe-area-inset-bottom)+1rem)] z-30 size-10 items-center justify-center rounded-full border bg-card text-muted-foreground shadow-2 transition-[transform,opacity] duration-base ease-out-soft hover:text-primary active:scale-95 motion-reduce:transition-none ${
        show ? "translate-y-0 opacity-100 md:flex" : "translate-y-2 opacity-0 md:hidden"
      }`}
    >
      <ArrowUp className="size-4" aria-hidden />
    </button>
  );
}
