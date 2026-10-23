import Link from "next/link";
import { notFound } from "next/navigation";

import { getForum } from "@/lib/queries/forums";
import { getForumModerators, getScopeChain } from "@/lib/authz/service";
import { and, eq, inArray } from "drizzle-orm";
import { getWebDb, roleGrants } from "@funwind/db";

export const dynamic = "force-dynamic";
export const metadata = { title: "版块权限视角" };

export default async function ForumAuthzPage({ params }: { params: Promise<{ fid: string }> }) {
  const { fid: fidRaw } = await params;
  const fid = Number(fidRaw);
  if (!Number.isInteger(fid)) notFound();
  const forum = await getForum(fid);
  if (!forum) notFound();

  const chain = await getScopeChain(fid);
  const db = getWebDb();

  const grants = await db
    .select({
      roleKey: roleGrants.roleKey,
      permissionKey: roleGrants.permissionKey,
      forumId: roleGrants.forumId,
    })
    .from(roleGrants)
    .where(and(eq(roleGrants.scopeType, "forum"), inArray(roleGrants.forumId, chain)));

  const moderators = await getForumModerators(fid);

  return (
    <div className="space-y-6">
      <nav className="text-sm text-muted-foreground">
        <Link href="/admin/authz" className="hover:text-primary">
          ← 角色与授权
        </Link>
        <span> / 版块视角</span>
      </nav>

      <header>
        <h1 className="text-xl font-bold">{forum.name} · 权限视角</h1>
        <p className="text-xs text-muted-foreground">
          作用域链：{chain.join(" ← ")}（子版块继承父级授权）
        </p>
      </header>

      <section className="rounded-xl border bg-card p-4">
        <h2 className="mb-2 font-semibold">派生版主（持有可编辑/可管理授权的用户，含父链继承）</h2>
        {moderators.length === 0 ? (
          <p className="text-sm text-muted-foreground">无（该版块链上暂无 write/manage 授权）</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {moderators.map((m) => (
              <Link
                key={m.userId}
                href={`/u/${m.userId}`}
                className="rounded-lg border px-3 py-1.5 text-sm hover:bg-accent"
              >
                {m.username}
                {m.viaParent && (
                  <span className="ml-1 text-xs text-muted-foreground">（继承）</span>
                )}
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-xl border bg-card p-4">
        <h2 className="mb-2 font-semibold">版块作用域授权（含继承）</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-1.5">角色</th>
              <th className="py-1.5">权限点</th>
              <th className="py-1.5">来源版块</th>
            </tr>
          </thead>
          <tbody>
            {grants.map((g, i) => (
              <tr key={i} className="border-b last:border-b-0">
                <td className="py-1.5">{g.roleKey}</td>
                <td className="py-1.5">
                  <code className="text-xs">{g.permissionKey}</code>
                </td>
                <td className="py-1.5 text-xs text-muted-foreground">
                  {g.forumId === fid ? "本版块" : `继承自 /f/${g.forumId}`}
                </td>
              </tr>
            ))}
            {grants.length === 0 && (
              <tr>
                <td colSpan={3} className="py-3 text-muted-foreground">
                  无
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
