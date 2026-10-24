import Link from "next/link";
import { createRoleAction, deleteRoleAction } from "@/app/admin/actions";
import { listRoles } from "@/lib/authz/admin";

export const dynamic = "force-dynamic";
export const metadata = { title: "角色与授权" };

export default async function AuthzPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const roles = await listRoles();

  return (
    <div className="space-y-8">
      {error && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <section>
        <h2 className="mb-3 border-b pb-1 font-semibold">角色</h2>
        <div className="space-y-2">
          {roles.map((r) => (
            <div
              key={r.key}
              className="flex items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Link href={`/admin/authz/${r.key}`} className="font-medium hover:text-primary">
                    {r.name}
                  </Link>
                  <code className="text-xs text-muted-foreground">{r.key}</code>
                  {r.kind === "builtin" ? (
                    <span className="rounded border px-1.5 text-xs text-muted-foreground">
                      内置
                    </span>
                  ) : (
                    <span className="rounded border border-primary/30 px-1.5 text-xs text-primary">
                      自定义
                    </span>
                  )}
                </div>
                {r.description && (
                  <p className="truncate text-xs text-muted-foreground">{r.description}</p>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                <Link
                  href={`/admin/authz/${r.key}`}
                  className="rounded-md border px-3 py-1 text-sm hover:bg-accent"
                >
                  授权矩阵
                </Link>
                {r.kind === "custom" && (
                  <form action={deleteRoleAction}>
                    <input type="hidden" name="key" value={r.key} />
                    <button
                      type="submit"
                      className="rounded-md border border-destructive/40 px-3 py-1 text-sm text-destructive hover:bg-destructive/10"
                    >
                      删除
                    </button>
                  </form>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-xl border bg-card p-5">
        <h2 className="mb-3 font-semibold">新建自定义角色</h2>
        <form action={createRoleAction} className="flex flex-wrap items-end gap-3">
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">角色键（kebab-case）</span>
            <input
              name="key"
              required
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              className="rounded-lg border border-input px-3 py-2 text-sm"
              placeholder="team-media"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">名称</span>
            <input
              name="name"
              required
              className="rounded-lg border border-input px-3 py-2 text-sm"
              placeholder="媒体组"
            />
          </label>
          <label className="block flex-1 space-y-1">
            <span className="text-xs text-muted-foreground">说明</span>
            <input
              name="description"
              className="w-full rounded-lg border border-input px-3 py-2 text-sm"
            />
          </label>
          <button
            type="submit"
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            创建
          </button>
        </form>
      </section>
    </div>
  );
}
