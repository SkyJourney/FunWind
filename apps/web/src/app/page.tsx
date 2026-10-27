import { Newspaper } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Slot } from "@/modules/kernel/slot";
import { ThreadRow } from "@/components/content/thread-row";
import { ForumDirectory } from "@/components/content/forum-directory";
import { isDevEnv } from "@/lib/dev-only";
import { getForumTree } from "@/lib/authz/snapshot";
import { getCurrentSubject } from "@/lib/authz/subject";
import { getDirectory } from "@/lib/queries/forums";
import { getLatestThreads } from "@/lib/queries/threads";

export const metadata: Metadata = { title: "青翼字幕组" };
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const viewer = await getCurrentSubject();
  // 目录、统计、最新动态全部按访客权限过滤：受限版块的名称/计数/主题不会出现在任何位置
  const [dir, latest, tree] = await Promise.all([
    getDirectory(viewer),
    getLatestThreads(viewer, 10),
    getForumTree(),
  ]);

  return (
    <main className="mx-auto max-w-5xl space-y-10 px-4 py-8 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">青翼字幕组</h1>
          <p className="text-sm text-muted-foreground">
            日语·ACG 情怀社区 —— {dir.forumCount} 个版块 · {dir.threadCount} 个主题
          </p>
        </div>
        {isDevEnv() && (
          <Link href="/design" className="text-xs text-muted-foreground hover:text-primary">
            设计令牌（内部）
          </Link>
        )}
      </header>

      <Slot name="home.after-header" />

      <ForumDirectory dir={dir} />

      <section>
        <h2 className="mb-2 flex items-center gap-1.5 border-b pb-1 text-base font-semibold">
          <Newspaper className="size-4" /> 最新动态
        </h2>
        <div>
          {latest.map((t) => (
            <ThreadRow key={t.id} thread={t} showForum forumName={tree.get(t.forumId)?.name} />
          ))}
        </div>
      </section>

      <Slot name="home.footer-notice" />
    </main>
  );
}
