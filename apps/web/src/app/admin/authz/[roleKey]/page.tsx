import Link from "next/link";
import { notFound } from "next/navigation";
import { grantAction, revokeAction } from "@/app/admin/actions";
import { getRoleGrants, listPermissions, listRoles } from "@/lib/authz/admin";
import { requireAdmin } from "@/lib/authz/require-admin";
import { getForumTree } from "@/lib/authz/snapshot";

export const dynamic = "force-dynamic";
export const metadata = { title: "授权矩阵" };

export default async function RoleMatrixPage({
  params,
  searchParams,
}: {
  params: Promise<{ roleKey: string }>;
  searchParams: Promise<{ error?: string; scopeForum?: string }>;
}) {
  // 第一个 await：局部渲染可能跳过 layout，页面自己必须鉴权（admin-entry-guard.test.ts 守护）
  await requireAdmin("admin.roles");
  const { roleKey } = await params;
  const { error, scopeForum } = await searchParams;

  const roles = await listRoles();
  const role = roles.find((r) => r.key === roleKey);
  if (!role) notFound();

  const perms = listPermissions();
  const [grants, tree] = await Promise.all([getRoleGrants(roleKey), getForumTree()]);
  const forums = tree.all();

  // 作用域：0 = 全局，>0 = 版块（编辑器一次只看一个作用域）
  const scopeForumId = scopeForum ? Number(scopeForum) : 0;
  const scopeIsForum = Number.isInteger(scopeForumId) && scopeForumId > 0 && tree.has(scopeForumId);
  const scopeId = scopeIsForum ? scopeForumId : 0;
  const grantSet = new Set(grants.filter((g) => g.scopeId === scopeId).map((g) => g.permissionKey));

  // 按资源分组；分级域（read/write/manage）展示为级别行
  const byResource = new Map<string, typeof perms>();
  for (const p of perms) {
    const list = byResource.get(p.resource) ?? [];
    list.push(p);
    byResource.set(p.resource, list);
  }

  const scopeLabel = scopeIsForum ? (tree.get(scopeId)?.name ?? `版块 ${scopeId}`) : "全局";

  return (
    <div className="space-y-6">
      <nav className="text-sm text-muted-foreground">
        <Link href="/admin/authz" className="hover:text-primary">
          ← 角色与授权
        </Link>
        <span> / {role.name}</span>
      </nav>

      {error && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <section className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">
          {role.name} <code className="text-xs text-muted-foreground">{role.key}</code>
        </h1>
        <p className="text-sm text-muted-foreground">作用域：{scopeLabel}</p>
        <form method="get" className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">作用域：</span>
          <select
            name="scopeForum"
            defaultValue={scopeIsForum ? String(scopeId) : ""}
            className="rounded-lg border border-input bg-background px-2 py-1.5"
          >
            <option value="">全局</option>
            {forums
              .filter((f) => f.kind === "forum")
              .map((f) => (
                <option key={f.id} value={f.id}>
                  {"　".repeat(Math.max(0, f.depth - 1))}
                  {f.name}
                </option>
              ))}
          </select>
          <button type="submit" className="rounded-md border px-3 py-1.5 hover:bg-accent">
            切换
          </button>
        </form>
      </section>

      <section className="space-y-4">
        {[...byResource.entries()].map(([resource, list]) => (
          <div key={resource} className="rounded-xl border bg-card p-4">
            <h2 className="mb-2 font-semibold">{resource}</h2>
            <div className="space-y-1.5">
              {list.map((p) => {
                const granted = grantSet.has(p.key);
                return (
                  <form
                    key={p.key}
                    action={grantAction}
                    className="flex items-center justify-between gap-2 py-0.5"
                  >
                    <input type="hidden" name="roleKey" value={roleKey} />
                    <input type="hidden" name="permissionKey" value={p.key} />
                    <input type="hidden" name="scopeId" value={String(scopeId)} />
                    <div className="min-w-0">
                      <code className="text-xs text-muted-foreground">{p.key}</code>
                      <span className="ml-2 text-sm">{p.description}</span>
                      {p.level && (
                        <span className="ml-1 rounded border px-1 text-xs text-muted-foreground">
                          {p.level}
                        </span>
                      )}
                    </div>
                    <button
                      type="submit"
                      className={`rounded-md border px-3 py-1 text-xs ${
                        granted ? "border-primary/40 bg-primary/10 text-primary" : "hover:bg-accent"
                      }`}
                    >
                      {granted ? "已授权 ✓" : "未授权"}
                    </button>
                  </form>
                );
              })}
            </div>
          </div>
        ))}
      </section>

      {scopeIsForum && (
        <section className="rounded-xl border bg-card p-4">
          <h2 className="mb-2 font-semibold">当前作用域已授权项</h2>
          <div className="space-y-1">
            {grants
              .filter((g) => g.scopeId === scopeId)
              .map((g) => (
                <form
                  key={g.permissionKey}
                  action={revokeAction}
                  className="flex items-center justify-between gap-2 text-sm"
                >
                  <input type="hidden" name="roleKey" value={roleKey} />
                  <input type="hidden" name="permissionKey" value={g.permissionKey} />
                  <input type="hidden" name="scopeId" value={String(scopeId)} />
                  <code className="text-xs">{g.permissionKey}</code>
                  <button type="submit" className="text-xs text-destructive hover:underline">
                    撤销
                  </button>
                </form>
              ))}
          </div>
        </section>
      )}
    </div>
  );
}
