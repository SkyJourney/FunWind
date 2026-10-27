import { Layers } from "lucide-react";
import type { Metadata } from "next";
import { ForumDirectory } from "@/components/content/forum-directory";
import { getCurrentSubject } from "@/lib/authz/subject";
import { getDirectory } from "@/lib/queries/forums";

export const metadata: Metadata = { title: "版块目录" };
export const dynamic = "force-dynamic";

/**
 * 版块目录页（M10.5）：分区 → 版块卡片。与首页共用 ForumDirectory；
 * 首页将在 S2 线稿翻转为「内容流优先」，目录以此页为家（底部 Tab「版块」的目标）。
 */
export default async function BoardsPage() {
  const viewer = await getCurrentSubject();
  // 与首页同口径：受限版块的名称/计数不出现在任何位置
  const dir = await getDirectory(viewer);

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Layers className="size-6 text-primary" aria-hidden />
          版块目录
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {dir.forumCount} 个版块 · {dir.threadCount} 个主题
        </p>
      </header>
      <ForumDirectory dir={dir} />
    </main>
  );
}
