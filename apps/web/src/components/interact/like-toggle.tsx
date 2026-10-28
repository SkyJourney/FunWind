"use client";

import { useOptimistic, useState, useTransition, type FormEvent } from "react";
import { ThumbsUp } from "lucide-react";
import { toast } from "sonner";
import { likeAction } from "@/app/actions/interact";

interface LikeState {
  liked: boolean;
  count: number;
}

/** 一次切换的动效记录：id 每次递增用作 key（让动画重播）；dir 为 +1 点赞 / -1 取消；prev 是切换前显示的文字（滚出的旧值） */
interface Fx {
  id: number;
  dir: 1 | -1;
  prev: string;
}

const labelOf = (count: number) => (count > 0 ? String(count) : "赞");

/**
 * 点赞按钮（M10.7 Step 5a）：乐观更新 + 微交互。
 * - 点击立即切换（图标 spring 弹一下、数字上滚 / 下滚、点赞时飘出 +1），不再等服务端整页刷新；
 * - Server Action 仍是唯一事实来源：完成后页面 revalidate，服务端 props 覆盖乐观值；失败则乐观值自动回滚并 toast；
 * - 无 JS 回退：<form action={likeAction}> 原样保留，没有 JS 时就是普通表单提交；
 * - 进行中忽略重复点击（防止快速连点产生奇偶错乱的多次切换）。
 */
export function LikeToggle({
  postId,
  liked,
  likeCount,
  back,
  canLike,
}: {
  postId: number;
  liked: boolean;
  likeCount: number;
  /** 站内回跳路径（revalidate 目标） */
  back: string;
  canLike: boolean;
}) {
  const [state, setOptimistic] = useOptimistic<LikeState, boolean>(
    { liked, count: likeCount },
    (cur, next) => ({ liked: next, count: Math.max(0, cur.count + (next ? 1 : -1)) }),
  );
  const [pending, startTransition] = useTransition();
  const [fx, setFx] = useState<Fx | null>(null);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    if (!canLike) return;
    e.preventDefault(); // 有 JS：接管提交；无 JS：这个处理器不存在，表单照常提交给 Server Action
    if (pending) return;
    const formData = new FormData(e.currentTarget);
    const next = !state.liked;
    setFx({ id: (fx?.id ?? 0) + 1, dir: next ? 1 : -1, prev: labelOf(state.count) });
    startTransition(async () => {
      setOptimistic(next);
      try {
        await likeAction(formData);
      } catch {
        toast.error("操作失败，请重试"); // 乐观值随事务结束自动回滚
      }
    });
  }

  return (
    <form action={likeAction} onSubmit={onSubmit} data-testid={`like-${postId}`}>
      <input type="hidden" name="postId" value={postId} />
      <input type="hidden" name="back" value={back} />
      <button
        type="submit"
        disabled={!canLike}
        aria-pressed={state.liked}
        aria-busy={pending}
        className={`relative inline-flex items-center gap-1 text-xs transition-colors duration-fast active:scale-95 ${
          state.liked ? "font-medium text-primary" : "text-muted-foreground hover:text-primary"
        } disabled:cursor-not-allowed disabled:opacity-60`}
      >
        <span
          title={canLike ? (state.liked ? "取消点赞" : "点赞") : "登录后可点赞"}
          className="inline-flex items-center gap-1"
        >
          {/* key 随每次切换变化：重新挂载即重播 spring 弹跳 */}
          <span key={fx?.id ?? 0} className={fx ? "fw-pop inline-flex" : "inline-flex"}>
            <ThumbsUp className={`size-3.5 ${state.liked ? "fill-primary/25" : ""}`} />
          </span>
          <span className="fw-roll">
            {fx && (
              <span
                key={`out-${fx.id}`}
                aria-hidden
                className={fx.dir === 1 ? "fw-roll-out-up" : "fw-roll-out-down"}
              >
                {fx.prev}
              </span>
            )}
            <span
              key={`in-${fx?.id ?? 0}`}
              className={fx ? (fx.dir === 1 ? "fw-roll-in-up" : "fw-roll-in-down") : undefined}
            >
              {labelOf(state.count)}
            </span>
          </span>
        </span>
        {/* 点赞时飘出的 +1（取消点赞不飘） */}
        {fx?.dir === 1 && (
          <span
            key={`float-${fx.id}`}
            aria-hidden
            className="fw-float-up pointer-events-none absolute -top-1 left-1 text-[11px] font-semibold text-primary"
          >
            +1
          </span>
        )}
      </button>
    </form>
  );
}
