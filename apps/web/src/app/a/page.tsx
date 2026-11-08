import Link from "next/link";

import { getCurrentSubject } from "@/lib/authz/subject";
import { listAnnouncements } from "@/lib/announcements/queries";

export const dynamic = "force-dynamic";
export const metadata = { title: "全部公告" };

/**
 * 公告归档页（M13 追加功能）：/a
 * 列出全部公告（含已结束——过期公告的详情页在此仍有归宿，不做死链）。
 * 游客只看 audience=all。
 */
export default async function AnnouncementsPage() {
  const subject = await getCurrentSubject();
  const loggedIn = subject.userId !== null;
  const items = await listAnnouncements(loggedIn);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-semibold">公告</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        站务公告与重要通知都在这里。顶部横幅是最新一条公告的入口。
      </p>

      {items.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">暂时没有公告。</p>
      ) : (
        <ul className="mt-6 space-y-3">
          {items.map((a) => (
            <li key={a.id} className="rounded-xl border bg-card p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/a/${a.id}`} className="text-base font-medium hover:underline">
                  {a.title}
                </Link>
                {a.level === "important" && (
                  <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive">
                    重要
                  </span>
                )}
                {!a.active && (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                    已结束
                  </span>
                )}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {a.startsAt}
                {a.endsAt ? ` ~ ${a.endsAt}` : " 起长期有效"}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
