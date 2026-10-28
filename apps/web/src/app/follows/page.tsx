import Link from "next/link";
import { Heart } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { redirect } from "next/navigation";
import { FeedCard } from "@/components/content/feed-card";
import { HomeFeedStream } from "@/components/content/home-feed-stream";
import { Pagination } from "@/components/content/pagination";
import { FollowButton } from "@/components/interact/follow-button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { getCurrentUser } from "@/lib/auth/session";
import { getCurrentSubject } from "@/lib/authz/subject";
import { getForumTree } from "@/lib/authz/snapshot";
import { getFollowFeed, followedThreadIds, type FollowFeedType } from "@/lib/queries/follows-feed";
import { followedLists } from "@/lib/queries/followed-lists";
import { fileUrl } from "@/lib/files";

export const dynamic = "force-dynamic";
export const metadata = { title: "关注动态" };

/** 关注动态（M8）：关注的板块新帖 + 关注用户的发帖。只聚合新版行为（旧动态流不迁）。
 * M10.6d：类型筛选 chips；卡片化与首页 FeedCard 同构 + 关注列表管理区（站长反馈：先看到关注了什么）。 */
export default async function FollowsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; type?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const sp = await searchParams;
  const rawPage = Math.max(1, Number(sp.page ?? "1") || 1);
  const type: FollowFeedType = sp.type === "forum" || sp.type === "user" ? sp.type : "all";
  const subject = await getCurrentSubject();
  const [feed, tree, followed] = await Promise.all([
    getFollowFeed(subject, rawPage, type),
    getForumTree(),
    (async () => {
      const { forumIds, userIds } = await followedThreadIds(user.id);
      return followedLists(user.id, forumIds, userIds);
    })(),
  ]);

  const chipHref = (t: FollowFeedType) => (t === "all" ? "/follows" : `/follows?type=${t}`);

  return (
    <main className="mx-auto max-w-4xl space-y-4 px-4 py-8 sm:px-6">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold tracking-tight">关注动态</h1>
        <p className="text-xs text-muted-foreground">
          关注的板块 {feed.forumCount} 个 · 用户 {feed.userCount} 人 · 共 {feed.total} 帖
        </p>
      </header>

      {/* 关注列表管理区（先看到关注了什么，就地取关） */}
      {(followed.forums.length > 0 || followed.users.length > 0) && (
        <section className="space-y-3 rounded-xl border bg-card p-4">
          {followed.forums.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground">关注的板块</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {followed.forums.map((f) => (
                  <span
                    key={f.id}
                    className="inline-flex items-center gap-1 rounded-full border py-0.5 pr-1 pl-2.5 text-xs"
                  >
                    <Link href={`/f/${f.id}`} className="hover:text-primary">
                      {f.name}
                    </Link>
                    <FollowButton
                      targetType="forum"
                      targetId={f.id}
                      following
                      back="/follows"
                      compact
                    />
                  </span>
                ))}
              </div>
            </div>
          )}
          {followed.users.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground">关注的用户</p>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {followed.users.map((u) => (
                  <span
                    key={u.id}
                    className="inline-flex items-center gap-1.5 rounded-full border py-0.5 pr-1 pl-1 text-xs"
                  >
                    <Link
                      href={`/u/${u.id}`}
                      className="flex items-center gap-1.5 hover:text-primary"
                    >
                      <Avatar className="size-5">
                        {u.avatarKey && <AvatarImage src={fileUrl(u.avatarKey)} alt="" />}
                        <AvatarFallback className="bg-primary/15 text-[10px]">
                          {u.username.slice(0, 1).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      {u.username}
                    </Link>
                    <FollowButton
                      targetType="user"
                      targetId={u.id}
                      following
                      back="/follows"
                      compact
                    />
                  </span>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      <nav aria-label="动态类型筛选" className="flex flex-wrap gap-1.5 text-sm">
        {(
          [
            ["all", "全部"],
            ["forum", `板块（${feed.forumCount}）`],
            ["user", `用户（${feed.userCount}）`],
          ] as const
        ).map(([value, label]) => (
          <Link
            key={value}
            href={chipHref(value)}
            aria-current={type === value ? "true" : undefined}
            className={
              type === value
                ? "rounded-full bg-primary px-3 py-1 font-medium text-primary-foreground"
                : "rounded-full border px-3 py-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            }
          >
            {label}
          </Link>
        ))}
      </nav>

      {feed.items.length === 0 ? (
        <EmptyState
          icon={Heart}
          title="还没有可显示的动态。"
          description="去板块页或用户资料页关注感兴趣的内容，新帖就会出现在这里。"
          action={
            <Button asChild variant="outline" size="sm">
              <Link href="/boards">去板块</Link>
            </Button>
          }
        />
      ) : (
        // M10.7 Step 3b：首屏服务端渲染（第 1 页前 10 张卡片错落进场），后续页触底追加；无 JS 由下方 noscript 翻页兜底
        <HomeFeedStream
          endpoint={`/api/stream/follows${type === "all" ? "" : `?type=${type}`}`}
          fallbackHref={chipHref(type)}
          startPage={feed.page}
          hasMore={feed.page < feed.totalPages}
          seedIds={feed.items.map((i) => i.id)}
          listClassName="space-y-3"
        >
          {feed.items.map((item, index) => (
            <div
              key={item.id}
              className={feed.page === 1 && index < 10 ? "fw-enter" : undefined}
              style={
                feed.page === 1 && index < 10 ? { animationDelay: `${index * 50}ms` } : undefined
              }
            >
              <FeedCard item={item} forumName={tree.get(item.forumId)?.name} />
            </div>
          ))}
        </HomeFeedStream>
      )}

      {/* 有 JS 时由触底追加接管；无 JS 时保留翻页。basePath 带上类型筛选（原先固定 /follows 会丢 ?type=） */}
      <noscript>
        <Pagination basePath={chipHref(type)} page={feed.page} totalPages={feed.totalPages} />
      </noscript>
    </main>
  );
}
