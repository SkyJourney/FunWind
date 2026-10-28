import { reactorsOf, type ReactorView } from "@/lib/interact/reactions";
import { UserBadge } from "@/components/content/user-badge";
import { LikeToggle } from "@/components/interact/like-toggle";

/**
 * 点赞按钮 + 点赞者弹层（M8）：点赞者弹层仍是服务端组件（<details> 折叠，无客户端 JS）；
 * 按钮本身是客户端组件 LikeToggle（M10.7 Step 5a：乐观更新 + 微交互，无 JS 时回退为表单）。
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
      <LikeToggle
        postId={postId}
        liked={liked}
        likeCount={likeCount}
        back={back}
        canLike={canLike}
      />
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
