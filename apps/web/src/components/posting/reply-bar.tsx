"use client";

import { PenLine, Send } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * 移动端快速回复固定条（M10.8 Step 8，线稿 thread ⑤）：悬在底部 Tab 栏上方的「写下你的回复…」假输入框，
 * 不是第二个编辑器——全页只有页面底部那一个编辑器，草稿 / 附件 / 上传状态因此不会冲突。
 *
 * - 点击：平滑滚到底部回复区并聚焦编辑器（减少动态效果时直接跳转）。
 * - **与回复区互斥**：回复区进入视口 → 固定条滑出；离开视口 → 滑回。用 IntersectionObserver 观察，
 *   只动 transform / opacity，时长走动效令牌；减少动态效果下无过渡（直接显隐）。
 * - 软键盘弹起（visualViewport 明显矮于窗口）时也收起，避免遮挡输入。
 * - 隐藏时 `inert`：不可聚焦、不被读屏读到。
 * 调用方只在「可以回复」时渲染本组件（与回复入口同一判定），所以这里不再判断权限。
 */
const noopSubscribe = () => () => {};

const SHOWN = "translate-y-0 opacity-100";
const HIDDEN = "pointer-events-none translate-y-full opacity-0";

export function ReplyBar({ targetId = "reply" }: { targetId?: string }) {
  // 回复区是否在视口内；初始假定「在」，由观察器的首次回调纠正，避免首屏闪一下
  const [replyVisible, setReplyVisible] = useState(true);
  const [keyboardUp, setKeyboardUp] = useState(false);
  // 是否支持观察器：服务端快照取「支持」，与现代浏览器的首次渲染一致（不会水合不匹配）；
  // 不支持的老环境无法判断回复区是否可见，宁可一直显示固定条（点击仍能到达回复区）
  const canObserve = useSyncExternalStore(
    noopSubscribe,
    () => typeof IntersectionObserver !== "undefined",
    () => true,
  );

  useEffect(() => {
    const target = document.getElementById(targetId);
    if (!target) return;
    if (!canObserve) return;
    const io = new IntersectionObserver(([entry]) =>
      setReplyVisible(entry?.isIntersecting ?? true),
    );
    io.observe(target);
    return () => io.disconnect();
  }, [targetId, canObserve]);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => setKeyboardUp(vv.height < window.innerHeight * 0.75);
    vv.addEventListener("resize", onResize);
    return () => vv.removeEventListener("resize", onResize);
  }, []);

  const show = (!canObserve || !replyVisible) && !keyboardUp;

  const goReply = () => {
    const target = document.getElementById(targetId);
    if (!target) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    // 编辑器在浏览器端创建，可能稍后才就绪：轮询几帧直到能聚焦
    let tries = 0;
    const focusEditor = () => {
      const box = target.querySelector<HTMLElement>('[role="textbox"]');
      if (box) {
        box.focus({ preventScroll: true });
        return;
      }
      if (++tries < 30) requestAnimationFrame(focusEditor);
    };
    focusEditor();
  };

  return (
    <div
      inert={!show}
      aria-hidden={!show}
      data-testid="reply-bar"
      className={`fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-30 border-t bg-background/95 px-3 py-2 backdrop-blur transition-[transform,opacity] duration-base ease-out-soft motion-reduce:transition-none md:hidden ${show ? SHOWN : HIDDEN}`}
    >
      <button
        type="button"
        onClick={goReply}
        aria-label="写回复"
        className="flex min-h-11 w-full items-center gap-2 rounded-full border bg-card px-4 text-left text-sm text-muted-foreground shadow-1 active:scale-[0.99]"
      >
        <PenLine className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">写下你的回复…</span>
        <Send className="size-4 shrink-0 text-primary" aria-hidden />
      </button>
    </div>
  );
}
