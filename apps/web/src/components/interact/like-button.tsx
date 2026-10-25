import { ThumbsUp } from "lucide-react";
import { likeAction } from "@/app/actions/interact";
import { reactorsOf, type ReactorView } from "@/lib/interact/reactions";
import { UserBadge } from "@/components/content/user-badge";

/**
 * 点赞按钮 + 点赞者弹层（M8，纯服务端组件：<details> 折叠，无客户端 JS）。
 * 游客按钮禁用（title 提示登录）；toggle 由 Server Action 完成后 revalidate 帖子页。
 */
export async function LikeButton({
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
  const reactors: ReactorView[] = likeCount > 0 ? await reactorsOf(postId) : [];
  return (
    <span className="flex items-center gap-2">
      <form action={likeAction}>
        <input type="hidden" name="postId" value={postId} />
        <input type="hidden" name="back" value={back} />
        <button
          type="submit"
          disabled={!canLike}
          title={canLike ? (liked ? "取消点赞" : "点赞") : "登录后可点赞"}
          className={`inline-flex items-center gap-1 text-xs ${
            liked ? "font-medium text-primary" : "text-muted-foreground hover:text-primary"
          } disabled:cursor-not-allowed disabled:opacity-60`}
        >
          <ThumbsUp className="size-3.5" />
          {likeCount > 0 ? likeCount : "赞"}
        </button>
      </form>
      {likeCount > 0 && (
        <details className="relative">
          <summary className="cursor-pointer list-none text-xs text-muted-foreground hover:text-primary">
            {likeCount} 人赞过
          </summary>
          <div className="absolute left-0 z-10 mt-1 w-52 rounded-lg border bg-card p-2 shadow-sm">
            <ul className="space-y-1">
              {reactors.map((r) => (
                <li key={r.userId} className="text-xs">
                  <UserBadge
                    uid={r.deleted || !r.username ? undefined : r.userId}
                    name={r.username}
                    deleted={r.deleted}
                  />
                </li>
              ))}
            </ul>
            {likeCount > reactors.length && (
              <p className="mt-1 border-t pt-1 text-xs text-muted-foreground">
                … 等共 {likeCount} 人
              </p>
            )}
          </div>
        </details>
      )}
    </span>
  );
}
