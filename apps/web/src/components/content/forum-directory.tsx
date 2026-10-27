import Link from "next/link";
import type { Directory } from "@/lib/queries/forums";

/**
 * 版块目录（首页与 /boards 共用）：分区 → 卡片网格。
 * 数据在查询层已按访客权限过滤，这里不做权限判断。
 */
export function ForumDirectory({ dir }: { dir: Directory }) {
  return (
    <section className="space-y-6">
      {dir.groups.map(({ section, forums }) => (
        <div key={section?.id ?? "loose"}>
          {section && (
            <h2 className="mb-2 border-b pb-1 text-base font-semibold text-foreground/90">
              {section.name}
            </h2>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            {forums.map((forum) => (
              <div key={forum.id} className="rounded-xl border bg-card p-4">
                <Link
                  href={`/f/${forum.id}`}
                  className="font-medium hover:text-primary hover:underline"
                >
                  {forum.name}
                </Link>
                {forum.description && (
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {forum.description}
                  </p>
                )}
                <div className="mt-2 text-xs text-muted-foreground">
                  主题 {forum.threadCount}
                  {forum.subs.length > 0 && (
                    <span className="ml-3 inline-flex flex-wrap gap-x-2">
                      {forum.subs.map((s) => (
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
  );
}
