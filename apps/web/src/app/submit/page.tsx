import { ArrowRight, Layers, PenLine } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { getCurrentSubject } from "@/lib/authz/subject";
import { getCurrentUser } from "@/lib/auth/session";
import { loadComposeAccess } from "@/lib/posting/compose-access";
import { getDirectory } from "@/lib/queries/forums";

export const metadata: Metadata = { title: "选择版块发帖" };
export const dynamic = "force-dynamic";

/**
 * 全站发帖入口（M10.5 底部 Tab「发帖」的落点）：列出当前用户可发帖的版块，
 * 选中后进入 /f/[fid]/new。可发性复用 loadComposeAccess（权限/归档/分区同口径），
 * 不在此重复权限逻辑。
 */
export default async function SubmitPage() {
  const viewer = await getCurrentSubject();
  const user = await getCurrentUser();

  if (!user) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <Card>
          <CardContent className="space-y-3 pt-6 text-sm">
            <p>登录后即可发帖。</p>
            <Link href="/login" className="text-primary hover:underline">
              去登录
            </Link>
          </CardContent>
        </Card>
      </main>
    );
  }

  const dir = await getDirectory(viewer);
  const groups = await Promise.all(
    dir.groups.map(async ({ section, forums }) => {
      const rows = (
        await Promise.all(
          forums.map(async (forum) => {
            // 顶层版块与其子版块都是候选；分区本身不可发帖
            const candidates = [
              { id: forum.id, name: forum.name, description: forum.description },
              ...forum.subs.map((s) => ({ id: s.id, name: s.name, description: null })),
            ];
            const ok: { id: number; name: string; description: string | null }[] = [];
            for (const c of candidates) {
              const access = await loadComposeAccess(viewer, c.id, "forum");
              if (access.mode === "form") ok.push(c);
            }
            return ok;
          }),
        )
      ).flat();
      return { section, forums: rows };
    }),
  );
  const postable = groups.filter((g) => g.forums.length > 0);

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-6">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <PenLine className="size-6 text-primary" aria-hidden />
          选择版块发帖
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">选一个版块，开始新的主题</p>
      </header>

      {postable.length === 0 ? (
        <Card>
          <CardContent className="space-y-3 pt-6 text-sm">
            <p>你暂时没有可发帖的版块。</p>
            <Link href="/boards" className="text-primary hover:underline">
              先去逛逛版块
            </Link>
          </CardContent>
        </Card>
      ) : (
        <section className="space-y-5">
          {postable.map(({ section, forums }) => (
            <div key={section?.id ?? "loose"}>
              {section && (
                <h2 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
                  <Layers className="size-3.5" aria-hidden />
                  {section.name}
                </h2>
              )}
              <div className="divide-y rounded-xl border bg-card">
                {forums.map((forum) => (
                  <Link
                    key={forum.id}
                    href={`/f/${forum.id}/new`}
                    className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-medium group-hover:text-primary">{forum.name}</p>
                      {forum.description && (
                        <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                          {forum.description}
                        </p>
                      )}
                    </div>
                    <ArrowRight
                      className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary"
                      aria-hidden
                    />
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}
