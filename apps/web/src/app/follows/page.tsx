import Link from "next/link";
import { redirect } from "next/navigation";
import { ThreadRow } from "@/components/content/thread-row";
import { Pagination } from "@/components/content/pagination";
import { getCurrentUser } from "@/lib/auth/session";
import { getCurrentSubject } from "@/lib/authz/subject";
import { getForumTree } from "@/lib/authz/snapshot";
import { getFollowFeed } from "@/lib/queries/follows-feed";

export const dynamic = "force-dynamic";
export const metadata = { title: "关注动态" };

/** 关注动态（M8）：关注的版块新帖 + 关注用户的发帖。只聚合新版行为（旧动态流不迁） */
export default async function FollowsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const rawPage = Math.max(1, Number((await searchParams).page ?? "1") || 1);
  const [feed, tree] = await Promise.all([
    getFollowFeed(await getCurrentSubject(), rawPage),
    getForumTree(),
  ]);

  return (
    <main className="mx-auto max-w-4xl space-y-4 px-4 py-8 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold tracking-tight">关注动态</h1>
        <p className="text-xs text-muted-foreground">
          关注的版块 {feed.forumCount} 个 · 用户 {feed.userCount} 人 · 共 {feed.total} 帖
        </p>
      </header>

      {feed.items.length === 0 ? (
        <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
          <p>还没有可显示的动态。</p>
          <p className="mt-2">
            去{" "}
            <Link href="/" className="text-primary hover:underline">
              版块页
            </Link>{" "}
            或 用户资料页关注感兴趣的内容，新帖就会出现在这里。
          </p>
        </div>
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
