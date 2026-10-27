import Link from "next/link";
import { MessageSquareOff } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { FollowButton } from "@/components/interact/follow-button";
import { isFollowing } from "@/lib/interact/follows";
import { getCurrentUser } from "@/lib/auth/session";
import { getProfile } from "@/lib/queries/users";
import { fileUrl } from "@/lib/files";

/**
 * 悬浮名片（M10.6d，S2 profile 线稿定稿项）：桌面 hover 用户名/头像 → 快速身份卡，
 * 私信发起的关键路径（与公开页按钮同一套 pm_policy 三态前置，判定最终在服务端）。
 * 服务端预取数据（hover-card 内容无第二跳）；注销/无名/无 uid 不启用。
 */
export async function UserHoverCard({
  uid,
  name,
  deleted = false,
  children,
}: {
  uid?: number;
  name: string | null;
  deleted?: boolean;
  children: React.ReactNode;
}) {
  const gone = deleted || !name;
  if (gone || uid === undefined) {
    return <span className="contents">{children}</span>;
  }
  const [profile, viewer] = await Promise.all([getProfile(uid), getCurrentUser()]);
  if (!profile) return <span className="contents">{children}</span>;
  const isSelf = viewer?.id === uid;
  const following = viewer && !isSelf ? await isFollowing(viewer.id, "user", uid) : false;
  const pmBack =
    profile.pmPolicy === "following" && viewer && !isSelf
      ? await isFollowing(uid, "user", viewer.id)
      : false;
  const pmAllowed =
    isSelf || profile.pmPolicy === "all" || (profile.pmPolicy === "following" && pmBack);

  const card = (
    <div className="w-64 space-y-2.5 p-3">
      <div className="flex items-center gap-2.5">
        <Avatar className="size-11">
          {profile.avatarKey && <AvatarImage src={fileUrl(profile.avatarKey)} alt={name} />}
          <AvatarFallback className="bg-primary/15">
            {name!.slice(0, 1).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{name}</p>
          <p className="text-xs text-muted-foreground">注册于 {profile.createdAt.slice(0, 10)}</p>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        主题 {profile.threadCount} · 回复 {profile.postCount} · 粉丝 {profile.followerCount} ·{" "}
        {profile.pointsName} {profile.points}
      </p>
      {!isSelf && (
        <div className="flex gap-2">
          <FollowButton
            targetType="user"
            targetId={uid}
            following={following}
            /* 名片悬停期间点关注后回到当前页即可（hover-card 非路由，无稳定 back 语义） */
            back="/"
          />
          {pmAllowed ? (
            <Link
              href={`/messages?to=${uid}`}
              className="flex-1 rounded-lg border px-3 py-1 text-center text-sm transition-colors hover:bg-accent"
            >
              ✉ 私信
            </Link>
          ) : (
            <span className="flex-1 rounded-lg border border-dashed px-2 py-1 text-center text-xs text-muted-foreground/80">
              <MessageSquareOff className="mr-0.5 inline size-3.5" aria-hidden />
              {profile.pmPolicy === "off" ? "已关闭私信" : "仅关注者可私信"}
            </span>
          )}
        </div>
      )}
    </div>
  );

  // HoverCard 内容在悬停时才挂载 —— 服务端预取由本组件在页面渲染期完成，卡片本体纯静态
  return (
    <span className="group/hc relative inline-flex" tabIndex={0}>
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute top-full left-0 z-50 mt-2 hidden rounded-xl border bg-card shadow-md transition-opacity group-focus-within/hc:inline-flex group-hover/hc:inline-flex"
      >
        <span className="pointer-events-auto inline-flex">{card}</span>
      </span>
    </span>
  );
}
