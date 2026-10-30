import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { FileText, MessageSquare, MessageSquareOff } from "lucide-react";
import { getWebDb, userProfiles } from "@funwind/db";
import { RichContent } from "@/components/content/rich-content";
import { ThreadRow } from "@/components/content/thread-row";
import { SegmentedNav } from "@/components/ui/segmented-nav";
import { ThreadStream } from "@/components/content/thread-stream";
import { UserReplyRow } from "@/components/content/user-reply-row";
import { UserReplyStream } from "@/components/content/user-reply-stream";
import { ImageLightbox } from "@/components/content/image-lightbox";
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
  const [viewer, viewerSubject] = await Promise.all([getCurrentUser(), getCurrentSubject()]);
  const profile = await getProfile(uid, viewerSubject);
  if (!profile) notFound();
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

  /** 流式追加的取数地址：与当前 tab 同口径（page 由组件追加） */
  const streamEndpoint = `/api/stream/user/${uid}?tab=${tab}`;

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
                  {profile.ban ? (
                    <span className="inline-flex items-center gap-1 rounded-lg border border-dashed px-3 py-1 text-sm text-muted-foreground/70">
                      <MessageSquareOff className="size-3.5" aria-hidden /> 暂不能接收新私信
                    </span>
                  ) : pmPolicy === "off" ? (
                    <span className="inline-flex items-center gap-1 rounded-lg border border-dashed px-3 py-1 text-sm text-muted-foreground/70">
                      <MessageSquareOff className="size-3.5" aria-hidden /> 已关闭私信
                    </span>
                  ) : pmPolicy === "following" && !pmBack ? (
                    // 受限态必须「可见可读」（title 属性在移动端不可达）：明示规则 + 引导
                    <span className="inline-flex items-center gap-1 rounded-lg border border-dashed px-3 py-1 text-sm text-muted-foreground/80">
                      <MessageSquareOff className="size-3.5" aria-hidden /> TA
                      仅接受其关注的人的私信
                    </span>
                  ) : (
                    <Link
                      href={`/messages?to=${uid}`}
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
      <SegmentedNav
        ariaLabel="用户内容"
        activeKey={tab}
        items={[
          {
            key: "threads",
            href: pageHref({ tab: "threads", page: 1 }),
            label: `主题 ${profile.threadCount}`,
          },
          {
            key: "replies",
            href: pageHref({ tab: "replies", page: 1 }),
            label: `回复 ${profile.postCount}`,
          },
        ]}
      />

      {tab === "threads" && threads ? (
        threads.items.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="TA 还没有公开的主题"
            description="发布的主题会出现在这里"
          />
        ) : (
          // M10.7 Step 3b：首屏服务端渲染（第 1 页前 10 行错落进场），后续页触底追加；无 JS 由下方 noscript 翻页兜底
          <ThreadStream
            endpoint={streamEndpoint}
            fallbackHref={pageHref({ page: 1 })}
            startPage={threads.page}
            hasMore={threads.page < threads.totalPages}
            seedIds={threads.items.map((t) => t.id)}
            listClassName="divide-y rounded-xl border bg-card"
          >
            {threads.items.map((t, index) => (
              <ThreadRow
                key={t.id}
                thread={t}
                showForum
                className={threads.page === 1 && index < 10 ? "fw-enter" : undefined}
                style={
                  threads.page === 1 && index < 10
                    ? { animationDelay: `${index * 50}ms` }
                    : undefined
                }
              />
            ))}
          </ThreadStream>
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
          <UserReplyStream
            endpoint={streamEndpoint}
            fallbackHref={pageHref({ page: 1 })}
            startPage={replies.page}
            hasMore={replies.page < replies.totalPages}
            seedIds={replies.items.map((r) => r.postId)}
            listClassName="divide-y rounded-xl border bg-card"
          >
            {replies.items.map((r, index) => (
              <UserReplyRow
                key={r.postId}
                reply={r}
                className={replies.page === 1 && index < 10 ? "fw-enter" : undefined}
                style={
                  replies.page === 1 && index < 10
                    ? { animationDelay: `${index * 50}ms` }
                    : undefined
                }
              />
            ))}
          </UserReplyStream>
        )
      ) : null}

      {/* 有 JS 时由触底追加接管；无 JS 时保留翻页（URL 冻结约定，直链可分享） */}
      {content && content.totalPages > 1 && (
        <noscript>
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
        </noscript>
      )}

      <div className="text-center text-sm">
        <Link href="/" className="text-muted-foreground hover:text-primary">
          ← 返回首页
        </Link>
      </div>
      <ImageLightbox />
    </main>
  );
}
