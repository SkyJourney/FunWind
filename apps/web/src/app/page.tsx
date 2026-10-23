import { Newspaper } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Slot } from "@/modules/kernel/slot";
import { ThreadRow } from "@/components/content/thread-row";
import { buildForumTree, getAllForums, getForumThreadCounts } from "@/lib/queries/forums";
import { getLatestThreads } from "@/lib/queries/threads";

export const metadata: Metadata = { title: "青翼字幕组" };
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [rows, counts, latest] = await Promise.all([
    getAllForums(),
    getForumThreadCounts(),
    getLatestThreads(10),
  ]);
  const tree = buildForumTree(rows);
  const nameById = new Map(rows.map((r) => [r.id, r.name]));

  return (
    <main className="mx-auto max-w-5xl space-y-10 px-4 py-8 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">青翼字幕组</h1>
          <p className="text-sm text-muted-foreground">
            日语·ACG 情怀社区 —— {rows.filter((r) => r.type !== "category").length} 个版块 ·{" "}
            {[...counts.values()].reduce((a, b) => a + b, 0)} 个主题
          </p>
        </div>
        <Link href="/design" className="text-xs text-muted-foreground hover:text-primary">
          设计令牌（内部）
        </Link>
      </header>

      <Slot name="home.after-header" />

      <section className="space-y-6">
        {tree.map(({ category, forums }) => (
          <div key={category.id}>
            <h2 className="mb-2 border-b pb-1 text-base font-semibold text-foreground/90">
              {category.name}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {forums.map(({ forum, subs }) => (
                <div key={forum.id} className="rounded-xl border bg-card p-4">
                  <Link
                    href={`/f/${forum.id}`}
                    className="font-medium hover:text-primary hover:underline"
                    style={
                      forum.nameStyle.match(/color:\s*([^;"]+)/)?.[1]
                        ? { color: forum.nameStyle.match(/color:\s*([^;"]+)/)![1] }
                        : undefined
                    }
                  >
                    {forum.name}
                  </Link>
                  {forum.description && (
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                      {forum.description}
                    </p>
                  )}
                  <div className="mt-2 text-xs text-muted-foreground">
                    主题 {counts.get(forum.id) ?? 0}
                    {subs.length > 0 && (
                      <span className="ml-3 inline-flex flex-wrap gap-x-2">
                        {subs.map((s) => (
                          <Link key={s.id} href={`/f/${s.id}`} className="hover:text-primary">
                            ↳ {s.name}
                          </Link>
                        ))}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </section>

      <section>
        <h2 className="mb-2 flex items-center gap-1.5 border-b pb-1 text-base font-semibold">
          <Newspaper className="size-4" /> 最新动态
        </h2>
        <div>
          {latest.map((t) => (
            <ThreadRow key={t.id} thread={t} showForum forumName={nameById.get(t.forumId)} />
          ))}
        </div>
      </section>

      <Slot name="home.footer-notice" />
    </main>
  );
}
