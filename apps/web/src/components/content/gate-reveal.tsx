"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * 门控解锁 reveal（M16 Step 2，docs/motion-spec.md §6.3）：解锁成功后隐藏内容的进场过渡。
 *
 * 时序：解锁入口点击（客户端打 sessionStorage 标记，按 gateId 区分）→ Server Action 落库
 * → 页面 revalidate → open 状态渲染出 GateReveal → effect 读到本 gate 的标记 → 内容挂
 * fw-fade-in 淡入一次并清标记。首次访问已解锁内容（无标记）不播动画；reduce 下
 * fw-fade-in 被 globals.css 归零。解锁失败的 stale 标记无害：内容仍是 locked 时
 * GateReveal 不渲染，下次解锁成功才消费。
 */

const flagKey = (gateId: number) => `fw-gate-reveal:${gateId}`;

function markUnlocked(gateId: number): void {
  try {
    window.sessionStorage.setItem(flagKey(gateId), "1");
  } catch {
    // 存储不可用：无 reveal，功能不受影响
  }
}

/** 点击解锁按钮时打标记（表单仍走 Server Action，onClick 仅打标记） */
export function GateUnlockButton({
  gateId,
  disabled,
  children,
}: {
  gateId: number;
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="submit"
      disabled={disabled}
      onClick={() => markUnlocked(gateId)}
      className="rounded-md border border-primary/40 bg-primary/10 px-3 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:border-border disabled:bg-transparent disabled:text-muted-foreground"
    >
      {children}
    </button>
  );
}

/** 回复解锁入口：去回复的链接点击同样打标记（回复成功后 revalidate 出 open 内容）。 */
export function GateReplyLink({
  gateId,
  href,
  children,
}: {
  gateId: number;
  href: string;
  children: ReactNode;
}) {
  return (
    <a href={href} className="text-primary hover:underline" onClick={() => markUnlocked(gateId)}>
      {children}
    </a>
  );
}

/** open 内容的 reveal 包装：本会话刚解锁（有本 gate 标记）时淡入一次。 */
export function GateReveal({ gateId, children }: { gateId: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try {
      if (window.sessionStorage.getItem(flagKey(gateId)) === "1") {
        window.sessionStorage.removeItem(flagKey(gateId));
        ref.current?.classList.add("fw-fade-in");
      }
    } catch {
      // 存储不可用：无 reveal
    }
  }, [gateId]);
  return <div ref={ref}>{children}</div>;
}
