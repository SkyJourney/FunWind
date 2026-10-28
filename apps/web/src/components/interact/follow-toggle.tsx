"use client";

import { useOptimistic, useState, useTransition, type FormEvent } from "react";
import { Check } from "lucide-react";
import { toast } from "sonner";
import { followAction } from "@/app/actions/interact";

/**
 * 关注按钮（M10.7 Step 5b）：原地乐观切换。
 * 点击立即在「关注 / 已关注」之间切换（按钮 spring 弹一下、文案淡入、已关注显示对勾），不再等服务端整页刷新；
 * Server Action 仍是唯一事实来源，失败回滚并 toast；无 JS 时是普通表单提交。
 */
export function FollowToggle({
  targetType,
  targetId,
  following,
  back,
}: {
  targetType: "user" | "forum";
  targetId: number;
  following: boolean;
  back: string;
}) {
  const [optimistic, setOptimistic] = useOptimistic<boolean, boolean>(
    following,
    (_cur, next) => next,
  );
  const [pending, startTransition] = useTransition();
  /** 每次切换递增：作为 key 让弹跳与文案淡入重播；0 = 初始渲染，不播动画 */
  const [bump, setBump] = useState(0);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const formData = new FormData(e.currentTarget);
    const next = !optimistic;
    setBump((n) => n + 1);
    startTransition(async () => {
      setOptimistic(next);
      try {
        await followAction(formData);
      } catch {
        toast.error("操作失败，请重试");
      }
    });
  }

  const label = optimistic ? "已关注" : targetType === "user" ? "关注" : "加入关注";
  return (
    <form action={followAction} onSubmit={onSubmit}>
      <input type="hidden" name="targetType" value={targetType} />
      <input type="hidden" name="targetId" value={targetId} />
      <input type="hidden" name="back" value={back} />
      <button
        type="submit"
        key={bump}
        aria-pressed={optimistic}
        aria-busy={pending}
        title={optimistic ? "点击取消关注" : undefined}
        className={`inline-flex items-center gap-1 rounded-lg border px-3 py-1 text-sm transition-colors duration-base active:scale-95 ${
          bump > 0 ? "fw-pop" : ""
        } ${
          optimistic
            ? "border-border text-muted-foreground hover:border-destructive/40 hover:text-destructive"
            : "border-primary bg-primary font-medium text-primary-foreground hover:bg-primary/90"
        }`}
      >
        {optimistic && <Check className="size-3.5" aria-hidden />}
        <span key={`${bump}-${optimistic}`} className={bump > 0 ? "fw-fade-in" : undefined}>
          {label}
        </span>
      </button>
    </form>
  );
}
