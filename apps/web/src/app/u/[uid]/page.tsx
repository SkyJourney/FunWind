import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { FileText, MessageSquare, MessageSquareOff } from "lucide-react";
import { getWebDb, userProfiles } from "@funwind/db";
import { RichContent } from "@/components/content/rich-content";
import { ThreadRow } from "@/components/content/thread-row";
import { EmptyState } from "@/components/empty-state";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Slot } from "@/modules/kernel/slot";
import { FollowButton } from "@/components/interact/follow-button";
import { isFollowing } from "@/lib/interact/follows";
import { getCurrentSubject } from "@/lib/authz/subject";
import { getCurrentUser } from "@/lib/auth/session";
import { fileUrl } from "@/lib/files";
import { getProfile, getUserReplies, getUserThreads } from "@/lib/queries/users";

export const dynamic = "force-dynamic";

const parseUid = (raw: string): number | null => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export async function generateMetadata({ params }: { params: Promise<{ uid: string }> }) {
  const uid = parseUid((await params).uid);
  const profile = uid ? await getProfile(uid) : null;
  return { title: profile?.username ?? "用户" };
}

/**
 * 个人公开页（M10.5 S5-B2，profile.html 定稿）：内容聚合式——身份头卡 + 主题/回复 Tab。
 * 发起私信按钮按对方 pm_policy 三态呈现（判定最终在服务端，这里只是前置体验）。
 */
export default async function ProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ uid: string }>;
  searchParams: Promise<{ tab?: string; page?: string }>;
}) {
  const uid = parseUid((await params).uid);
  if (!uid) notFound();
  // 不存在或已注销（含迁移生成的“已注销用户”占位账号）→ 404，占位账号不开个人页
  const profile = await getProfile(uid);
  if (!profile) notFound();
  const viewer = await getCurrentUser();
  const sp = await searchParams;
  const tab = sp.tab === "replies" ? "replies" : "threads";
  const page = Math.max(1, Math.trunc(Number(sp.page)) || 1);
  const isSelf = viewer?.id === uid;

  const following =
    viewer !== null && viewer.id !== uid ? await isFollowing(viewer.id, "user", uid) : false;

  // 私信入口三态：对方策略 + （following 档）对方是否关注我
  const [policyRow] = await getWebDb()
    .select({ pmPolicy: userProfiles.pmPolicy })
    .from(userProfiles)
    .where(eq(userProfiles.userId, uid))
    .limit(1);
  const pmPolicy = policyRow?.pmPolicy ?? "all";
  const pmBack =
    pmPolicy === "following" && viewer !== null && viewer.id !== uid
      ? await isFollowing(uid, "user", viewer.id)
      : false;

  const viewerSubject = await getCurrentSubject();
  const threads = tab === "threads" ? await getUserThreads(viewerSubject, uid, page) : null;
  const replies = tab === "replies" ? await getUserReplies(viewerSubject, uid, page) : null;
  const content = tab === "threads" ? threads : replies;
  const pageHref = (over: { tab?: string; page?: number }) => {
    const t = over.tab ?? tab;
    const p = over.page ?? 1;
    const q = new URLSearchParams();
    if (t !== "threads") q.set("tab", t);
    if (p > 1) q.set("page", String(p));
    const qs = q.toString();
    return qs ? `/u/${uid}?${qs}` : `/u/${uid}`;
  };

  return (
    <main className="mx-auto max-w-3xl space-y-4 px-4 py-8 sm:px-6">
      {/* 身份头卡 */}
      <Card>
        <CardContent className="flex items-start gap-4 pt-6">
          {profile.avatarKey ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={fileUrl(profile.avatarKey)}
              alt={profile.username}
              width={64}
              height={64}
              className="rounded-xl border bg-muted object-cover"
            />
          ) : (
            <Avatar className="size-16">
              <AvatarFallback className="text-xl">{profile.username.slice(0, 1)}</AvatarFallback>
            </Avatar>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold tracking-tight">{profile.username}</h1>
              {profile.ban && <Badge variant="destructive">已封禁</Badge>}
              {isSelf ? (
                <Link
                  href="/settings/avatar"
                  className="rounded-lg border px-3 py-1 text-sm transition-colors hover:bg-accent"
                >
                  编辑头像 / 资料
                </Link>
              ) : viewer ? (
                <>
                  <FollowButton
                    targetType="user"
                    targetId={uid}
                    following={following}
                    back={`/u/${uid}`}
                  />
                  {pmPolicy === "off" ? (
                    <span
                      className="inline-flex cursor-not-allowed items-center gap-1 rounded-lg border px-3 py-1 text-sm text-muted-foreground/60"
                      title="TA 已关闭私信"
                    >
                      <MessageSquareOff className="size-3.5" aria-hidden /> 已关闭私信
                    </span>
                  ) : (
                    <Link
                      href={`/messages?to=${uid}`}
                      title={
                        pmPolicy === "following" && !pmBack ? "TA 仅接受关注的人的私信" : undefined
                      }
                      className="rounded-lg border px-3 py-1 text-sm transition-colors hover:bg-accent"
                    >
                      ✉ 私信
                    </Link>
                  )}
                </>
              ) : null}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              注册于 {profile.createdAt} · 主题 {profile.threadCount} · 帖子 {profile.postCount} ·
              精华 {profile.featuredCount} · 粉丝 {profile.followerCount} · {profile.pointsName}{" "}
              {profile.points}
            </p>
            {profile.ban && (
              <p className="mt-2 text-sm text-destructive">
                封禁中{profile.ban.endsAt ? `（至 ${profile.ban.endsAt}）` : "（永久）"}
                {profile.ban.reason ? `：${profile.ban.reason}` : ""}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Slot name="profile.header" ctx={{ userId: uid }} />

      {profile.signatureMd && (
        <Card>
          <CardContent className="pt-5">
            <RichContent md={profile.signatureMd} />
          </CardContent>
        </Card>
      )}

      {/* 内容聚合 Tabs */}
      <nav className="flex gap-0.5 rounded-lg bg-muted p-0.5 text-sm" aria-label="用户内容">
        <Link
          href={pageHref({ tab: "threads", page: 1 })}
          aria-current={tab === "threads" ? "page" : undefined}
          className={`flex-1 rounded-md px-3 py-1.5 text-center transition-colors ${
            tab === "threads" ? "bg-card font-semibold shadow-1" : "text-muted-foreground"
          }`}
        >
          主题 {profile.threadCount}
        </Link>
        <Link
          href={pageHref({ tab: "replies", page: 1 })}
          aria-current={tab === "replies" ? "page" : undefined}
          className={`flex-1 rounded-md px-3 py-1.5 text-center transition-colors ${
            tab === "replies" ? "bg-card font-semibold shadow-1" : "text-muted-foreground"
          }`}
        >
          回复 {profile.postCount}
        </Link>
      </nav>

      {tab === "threads" && threads ? (
        threads.items.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="TA 还没有公开的主题"
            description="发布的主题会出现在这里"
          />
        ) : (
          <div className="divide-y rounded-xl border bg-card">
            {threads.items.map((t) => (
              <ThreadRow key={t.id} thread={t} showForum />
            ))}
          </div>
        )
      ) : null}

      {tab === "replies" && replies ? (
        replies.items.length === 0 ? (
          <EmptyState
            icon={MessageSquare}
            title="TA 还没有公开的回复"
            description="回复会连同所属主题一起出现在这里"
          />
        ) : (
          <div className="divide-y rounded-xl border bg-card">
            {replies.items.map((r) => (
              <div key={r.postId} className="px-4 py-3">
                <p className="text-[13px] text-muted-foreground">
                  回复了
                  <Link href={`/p/${r.postId}`} className="mx-1 text-foreground hover:text-primary">
                    『{r.threadTitle}』
                  </Link>
                  <span className="ml-1">#{r.floor}</span>
                </p>
                {r.excerpt && <p className="mt-1 line-clamp-2 text-sm">{r.excerpt}</p>}
                <p className="mt-1 text-xs text-muted-foreground">{r.createdAt}</p>
              </div>
            ))}
          </div>
        )
      ) : null}

      {content && content.totalPages > 1 && (
        <div className="flex items-center justify-center gap-4 text-sm">
          {content.page > 1 && (
            <Link
              href={pageHref({ page: content.page - 1 })}
              className="text-muted-foreground hover:text-primary"
            >
              ← 上一页
            </Link>
          )}
          <span className="text-muted-foreground">
            第 {content.page} / {content.totalPages} 页
          </span>
          {content.page < content.totalPages && (
            <Link
              href={pageHref({ page: content.page + 1 })}
              className="text-muted-foreground hover:text-primary"
            >
              下一页 →
            </Link>
          )}
        </div>
      )}

      <div className="text-center text-sm">
        <Link href="/" className="text-muted-foreground hover:text-primary">
          ← 返回首页
        </Link>
      </div>
    </main>
  );
}
