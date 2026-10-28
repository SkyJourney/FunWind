import { followAction } from "@/app/actions/interact";
import { FollowToggle } from "@/components/interact/follow-toggle";
import { SubmitButton } from "@/components/ui/submit-button";

/**
 * 关注按钮（M8）：关注用户 / 版块 toggle。服务端组件分发：普通形态用客户端 FollowToggle（乐观更新 + 微交互）。
 * following 时按钮为次要样式（点击取关）。
 * compact=true：关注列表管理区的 chip 形态（仅「×」，取消关注）。
 */
export function FollowButton({
  targetType,
  targetId,
  following,
  back,
  compact = false,
}: {
  targetType: "user" | "forum";
  targetId: number;
  following: boolean;
  back: string;
  /** chip 形态：只在已关注时渲染一个小 ×（取消关注）；未关注时不渲染任何东西 */
  compact?: boolean;
}) {
  if (compact && !following) return null;
  // 非 compact：客户端乐观切换（M10.7 Step 5b）；compact（关注管理区的 ×）保持服务端表单
  if (!compact) {
    return (
      <FollowToggle targetType={targetType} targetId={targetId} following={following} back={back} />
    );
  }
  return (
    <form action={followAction}>
      <input type="hidden" name="targetType" value={targetType} />
      <input type="hidden" name="targetId" value={targetId} />
      <input type="hidden" name="back" value={back} />
      <SubmitButton
        aria-label="取消关注"
        title="取消关注"
        className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:bg-accent hover:text-destructive"
        pendingText="…"
      >
        ×
      </SubmitButton>
    </form>
  );
}
