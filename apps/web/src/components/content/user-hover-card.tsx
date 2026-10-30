import Link from "next/link";
import { MessageSquareOff } from "lucide-react";
import { HoverCard as HoverCardPrimitive } from "radix-ui";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { FollowButton } from "@/components/interact/follow-button";
import { isFollowing } from "@/lib/interact/follows";
import { getCurrentUser } from "@/lib/auth/session";
import { getCurrentSubject } from "@/lib/authz/subject";
import { getProfile } from "@/lib/queries/users";
import { fileUrl } from "@/lib/files";

/**
 * 悬浮名片（S2 profile 线稿定稿项；M10.6d 改用 Radix HoverCard）：
 * hover 用户名/头像 → 快速身份卡（私信发起的关键路径）。
 * 此前自写 CSS group-hover 版在鼠标移向卡片的间隙就消失、卡内交互点不到——Radix 的
 * pointerEnter/Leave 带延迟宽限且卡片与触发器同属悬浮上下文，移动端点按也可开。
 * 数据在页面渲染期预取（无第二跳）；pm_policy 三态前置与公开页同口径，判定最终在服务端。
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
  const [viewer, viewerSubject] = await Promise.all([getCurrentUser(), getCurrentSubject()]);
  const profile = await getProfile(uid, viewerSubject);
  if (!profile) return <span className="contents">{children}</span>;
  const isSelf = viewer?.id === uid;
  const following = viewer && !isSelf ? await isFollowing(viewer.id, "user", uid) : false;
  const pmBack =
    profile.pmPolicy === "following" && viewer && !isSelf
      ? await isFollowing(uid, "user", viewer.id)
      : false;
  const pmAllowed =
    !profile.ban &&
    (isSelf || profile.pmPolicy === "all" || (profile.pmPolicy === "following" && pmBack));

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
      {profile.publicRoles.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {profile.publicRoles.map((role) => (
            <span
              key={`${role.key}:${role.scopeId}`}
              className="rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary"
            >
              {role.scopeId === 0 ? role.name : `${role.name} · ${role.scopeLabel}`}
            </span>
          ))}
        </div>
      )}
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
              {profile.ban
                ? "暂不能接收新私信"
                : profile.pmPolicy === "off"
                  ? "已关闭私信"
                  : "仅关注者可私信"}
            </span>
          )}
        </div>
      )}
    </div>
  );

  return (
    <HoverCardPrimitive.Root openDelay={150} closeDelay={120}>
      <HoverCardPrimitive.Trigger asChild>
        <span className="inline-flex cursor-pointer" tabIndex={0}>
          {children}
        </span>
      </HoverCardPrimitive.Trigger>
      <HoverCardPrimitive.Content
        side="bottom"
        align="start"
        sideOffset={6}
        className="z-50 w-64 rounded-xl border bg-card p-0 shadow-md"
      >
        {card}
      </HoverCardPrimitive.Content>
    </HoverCardPrimitive.Root>
  );
}
