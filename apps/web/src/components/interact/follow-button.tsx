import { followAction } from "@/app/actions/interact";
import { SubmitButton } from "@/components/ui/submit-button";

/**
 * 关注按钮（M8，纯服务端组件）：关注用户 / 版块 toggle。
 * following 时按钮为次要样式（点击取关）。
 */
export function FollowButton({
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
  return (
    <form action={followAction}>
      <input type="hidden" name="targetType" value={targetType} />
      <input type="hidden" name="targetId" value={targetId} />
      <input type="hidden" name="back" value={back} />
      <SubmitButton
        className={
          following
            ? "rounded-lg border px-3 py-1 text-sm text-muted-foreground hover:text-foreground"
            : "rounded-lg bg-primary px-3 py-1 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        }
        pendingText="…"
      >
        {following ? "已关注 · 取关" : targetType === "user" ? "关注" : "加入关注"}
      </SubmitButton>
    </form>
  );
}
