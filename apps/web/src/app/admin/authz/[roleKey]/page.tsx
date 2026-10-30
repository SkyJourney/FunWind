import { notFound } from "next/navigation";
import { grantAction, revokeAction, setRolePublicAction } from "@/app/admin/actions";
import { getRoleGrants, listPermissions, listRoles } from "@/lib/authz/admin";
import { requireAdmin } from "@/lib/authz/require-admin";
import { getForumTree } from "@/lib/authz/snapshot";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { AutoSubmitSelect } from "@/components/admin/auto-submit-select";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";

export const dynamic = "force-dynamic";
export const metadata = { title: "授权矩阵" };

export default async function RoleMatrixPage({
  params,
  searchParams,
}: {
  params: Promise<{ roleKey: string }>;
  searchParams: Promise<{ error?: string; scopeForum?: string; public?: string }>;
}) {
  // 第一个 await：局部渲染可能跳过 layout，页面自己必须鉴权（admin-entry-guard.test.ts 守护）
  await requireAdmin("admin.roles");
  const { roleKey } = await params;
  const { error, scopeForum, public: publicSaved } = await searchParams;

  const roles = await listRoles();
  const role = roles.find((r) => r.key === roleKey);
  if (!role) notFound();

  const perms = listPermissions();
  const [grants, tree] = await Promise.all([getRoleGrants(roleKey), getForumTree()]);
  const forums = tree.all();

  // 作用域：0 = 全局，>0 = 板块（编辑器一次只看一个作用域）
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

  const scopeLabel = scopeIsForum ? (tree.get(scopeId)?.name ?? `板块 ${scopeId}`) : "全局";

  return (
    <div className="space-y-6">
      <AdminPageHeader
        back="/admin/authz"
        backLabel="角色与授权"
        title={
          <>
            {role.name} <code className="text-xs text-muted-foreground">{role.key}</code>
          </>
        }
        stats={`作用域：${scopeLabel}`}
        actions={
          <form method="get" className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">作用域：</span>
            <AutoSubmitSelect
              name="scopeForum"
              defaultValue={scopeIsForum ? String(scopeId) : ""}
              aria-label="切换作用域"
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
            </AutoSubmitSelect>
            <noscript>
              <button type="submit" className="rounded-md border px-3 py-1.5 hover:bg-accent">
                切换
              </button>
            </noscript>
          </form>
        }
      />

      {error && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {publicSaved === "1" && (
        <p className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
          公开身份策略已保存。
        </p>
      )}
      {role.kind === "custom" && (
        <section className="rounded-xl border bg-card p-4">
          <h2 className="font-semibold">公开身份</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            仅显式公开的自定义角色会显示在用户名片；板块作用域身份会标注为板块范围。含后台管理权限的角色不能公开。
          </p>
          <form action={setRolePublicAction} className="mt-3 flex flex-wrap items-center gap-4">
            <input type="hidden" name="roleKey" value={roleKey} />
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="isPublic"
                value="on"
                defaultChecked={role.isPublic}
                className="size-4"
              />
              公开展示
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="isPublic"
                value="off"
                defaultChecked={!role.isPublic}
                className="size-4"
              />
              隐藏
            </label>
            <button type="submit" className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent">
              保存公开策略
            </button>
          </form>
        </section>
      )}

      <section className="space-y-3">
        {[...byResource.entries()].map(([resource, list]) => {
          const resourceGranted = list.filter((p) => grantSet.has(p.key)).length;
          return (
            <details
              key={resource}
              className="rounded-xl border bg-card p-4"
              // 默认展开当前作用域有授权的组，收起无授权组
              open={resourceGranted > 0}
            >
              <summary className="flex cursor-pointer items-center gap-2 font-semibold select-none">
                {resource}
                <span className="text-xs font-normal text-muted-foreground">
                  {resourceGranted}/{list.length} 已授权（当前作用域）
                </span>
              </summary>
              <div className="mt-2 space-y-1.5">
                {list.map((p) => {
                  const granted = grantSet.has(p.key);
                  return (
                    <form
                      key={p.key}
                      action={granted ? revokeAction : grantAction}
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
                      {/* 双向 toggle：已授权=撤销（确认），未授权=授权（M9.5 交互合一） */}
                      {granted ? (
                        <ConfirmSubmit
                          title="撤销授权"
                          description={`确认撤销 ${roleKey} 在当前作用域的 ${p.key} 授权？撤销后依赖该权限的后台功能立即失效。`}
                          className="rounded-md border border-destructive/40 px-3 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-60"
                          pendingText="…"
                        >
                          已授权 ✓ 撤销
                        </ConfirmSubmit>
                      ) : (
                        <button
                          type="submit"
                          className="rounded-md border px-3 py-1 text-xs hover:bg-accent"
                        >
                          授权
                        </button>
                      )}
                    </form>
                  );
                })}
              </div>
            </details>
          );
        })}
      </section>

      {scopeIsForum && grants.filter((g) => g.scopeId === scopeId).length > 0 && (
        <p className="text-xs text-muted-foreground">
          当前板块作用域共 {grants.filter((g) => g.scopeId === scopeId).length}{" "}
          项授权（见上方各组内「已授权 ✓ 撤销」按钮）。
        </p>
      )}
    </div>
  );
}
