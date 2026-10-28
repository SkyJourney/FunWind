import Link from "next/link";
import { Heart } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { redirect } from "next/navigation";
import { ThreadRow } from "@/components/content/thread-row";
import { Pagination } from "@/components/content/pagination";
import { getCurrentUser } from "@/lib/auth/session";
import { getCurrentSubject } from "@/lib/authz/subject";
import { getForumTree } from "@/lib/authz/snapshot";
import { getFollowFeed, type FollowFeedType } from "@/lib/queries/follows-feed";

export const dynamic = "force-dynamic";
export const metadata = { title: "关注动态" };

/** 关注动态（M8）：关注的板块新帖 + 关注用户的发帖。只聚合新版行为（旧动态流不迁）。
 * M10.6d：类型筛选 chips（全部/板块/人，线稿注记①）。 */
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
  const [feed, tree] = await Promise.all([
    getFollowFeed(await getCurrentSubject(), rawPage, type),
    getForumTree(),
  ]);

  const chipHref = (t: FollowFeedType) => (t === "all" ? "/follows" : `/follows?type=${t}`);

  return (
    <main className="mx-auto max-w-4xl space-y-4 px-4 py-8 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold tracking-tight">关注动态</h1>
        <p className="text-xs text-muted-foreground">
          关注的板块 {feed.forumCount} 个 · 用户 {feed.userCount} 人 · 共 {feed.total} 帖
        </p>
      </header>

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
              <Link href="/">板块页</Link>
            </Button>
          }
        />
      ) : (
        <div className="space-y-2">
          {feed.items.map((t) => (
            <ThreadRow key={t.id} thread={t} showForum forumName={tree.get(t.forumId)?.name} />
          ))}
        </div>
      )}

      <Pagination basePath="/follows" page={feed.page} totalPages={feed.totalPages} />
    </main>
  );
}
