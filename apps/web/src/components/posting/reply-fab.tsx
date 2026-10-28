"use client";

import { MessageSquarePlus } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * 移动端回复悬浮按钮（M10.8 Step 8，站长实测后由「整行固定条」改为圆形按钮）：悬在帖子页右下角、底部 Tab 栏上方。
 *
 * 为什么不是固定条：固定条带整行背景层，会遮挡正常浏览；而它点击后要跳到页面底部才能输入，
 * 既不是「快速回复」（不能就地输入提交）又占地方。圆形按钮只占一个指尖大小，没有背景层。
 * 它不是第二个编辑器——全页只有页面底部那一个，草稿 / 附件 / 上传状态因此不会冲突。
 *
 * - 点击：跳到底部回复区并**立即**聚焦编辑器（见 goReply 的说明）。
 * - **与回复区互斥**：回复区进入视口 → 按钮缩小淡出；离开视口 → 回来。IntersectionObserver 观察，
 *   只动 transform / opacity，时长走动效令牌；减少动态效果下无过渡（直接显隐）。
 * - 软键盘弹起（visualViewport 明显矮于窗口）时也收起，避免遮挡输入。
 * - 隐藏时 `inert`：不可聚焦、不被读屏读到。
 * 调用方只在「可以回复」时渲染本组件（与回复入口同一判定），所以这里不再判断权限。
 */
const noopSubscribe = () => () => {};

const SHOWN = "scale-100 opacity-100";
const HIDDEN = "pointer-events-none scale-50 opacity-0";

/** 聚焦回复区里的编辑器；编辑器在浏览器端创建，可能稍后才就绪：轮询几帧直到能聚焦 */
function focusEditor(target: HTMLElement) {
  let tries = 0;
  const attempt = () => {
    const box = target.querySelector<HTMLElement>('[role="textbox"]');
    if (box) {
      box.focus({ preventScroll: true });
      return;
    }
    if (++tries < 30) requestAnimationFrame(attempt);
  };
  attempt();
}

export function ReplyFab({ targetId = "reply" }: { targetId?: string }) {
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
    // 瞬时跳到回复区并立即聚焦（站长拍板）：编辑器的 focus() 即使带 preventScroll 也会让页面一步跳过去、
    // 并取消进行中的平滑滚动，所以「平滑滚动 + 聚焦」不可兼得；立即聚焦的好处是仍在用户手势内，iOS 才能唤起软键盘
    target.scrollIntoView({ behavior: "auto", block: "start" });
    focusEditor(target);
  };

  return (
    <button
      type="button"
      onClick={goReply}
      inert={!show}
      aria-hidden={!show}
      aria-label="回复本帖"
      data-testid="reply-fab"
      className={`fixed right-4 bottom-[calc(3.5rem+env(safe-area-inset-bottom)+1rem)] z-30 flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-3 transition-[transform,opacity] duration-base ease-out-soft active:scale-95 motion-reduce:transition-none md:hidden ${show ? SHOWN : HIDDEN}`}
    >
      <MessageSquarePlus className="size-5" aria-hidden />
    </button>
  );
}
