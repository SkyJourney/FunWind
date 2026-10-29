import Link from "next/link";
import { Users } from "lucide-react";
import { requireAdmin } from "@/lib/authz/require-admin";
import { listAdminUsersPage } from "@/lib/authz/restrictions-admin";
import { fmtDateTime } from "@/lib/admin/format";
import { AdminFilterBar } from "@/components/admin/admin-filter-bar";
import { Pagination } from "@/components/content/pagination";
import { EmptyState } from "@/components/empty-state";

export const dynamic = "force-dynamic";
export const metadata = { title: "用户管理" };

type Params = {
  searchParams: Promise<{ q?: string; status?: string; sort?: string; page?: string }>;
};

const SORTS = [
  { key: "recent", label: "最新注册" },
  { key: "id", label: "uid 顺序" },
  { key: "threads", label: "主题最多" },
] as const;

/** 用户管理列表（M9.5 重做）：默认列最近注册，关键词（uid 等值/用户名包含）+ 受限筛选 + 排序 + 分页。 */
export default async function AdminUsersPage({ searchParams }: Params) {
  await requireAdmin("admin.users");
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : "";
  const status = sp.status === "restricted" ? "restricted" : "all";
  const sort = SORTS.some((s) => s.key === sp.sort)
    ? (sp.sort as "recent" | "id" | "threads")
    : "recent";
  const page = Math.max(1, Number(sp.page ?? "1") || 1);

  const { items, total } = await listAdminUsersPage({ q, status, sort }, page);
  const totalPages = Math.max(1, Math.ceil(total / 20));

  const baseQuery = (over: Record<string, string>) => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (status !== "all") p.set("status", status);
    if (sort !== "recent") p.set("sort", sort);
    for (const [k, v] of Object.entries(over)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    const qs = p.toString();
    return `/admin/users${qs ? `?${qs}` : ""}`;
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <AdminFilterBar
          action="/admin/users"
          resetHref="/admin/users"
          placeholder="用户名 / uid"
          defaultValue={q}
        >
          <select
            name="status"
            defaultValue={status}
            aria-label="用户状态"
            className="rounded-lg border border-input bg-background px-2 py-1.5 text-sm"
          >
            <option value="all">全部状态</option>
            <option value="restricted">受限中</option>
          </select>
          <select
            name="sort"
            defaultValue={sort}
            aria-label="排序"
            className="rounded-lg border border-input bg-background px-2 py-1.5 text-sm"
          >
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </AdminFilterBar>
        <p className="text-xs text-muted-foreground">共 {total} 人</p>
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={Users}
          title={q || status !== "all" ? "没有匹配条件的用户。" : "还没有注册用户。"}
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <table className="w-full text-left text-sm">
            <thead className="border-b text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2">用户</th>
                <th className="px-3 py-2">注册时间</th>
                <th className="px-3 py-2 tabular-nums">主题 / 帖子</th>
                <th className="px-3 py-2">状态</th>
                <th className="px-3 py-2" aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {items.map((u) => (
                <tr key={u.id} className="border-t last:border-b-0">
                  <td className="px-3 py-2">
                    <Link href={`/admin/users/${u.id}`} className="font-medium hover:text-primary">
                      {u.username}
                    </Link>
                    <span className="ml-1.5 text-xs text-muted-foreground">uid {u.id}</span>
                  </td>
                  <td className="px-3 py-2 text-xs whitespace-nowrap text-muted-foreground">
                    {fmtDateTime(u.createdAt)}
                  </td>
                  <td className="px-3 py-2 text-xs tabular-nums">
                    {Number(u.threadCount ?? 0)} / {Number(u.postCount ?? 0)}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {u.restricted ? (
                      <span className="rounded-full bg-warning/10 px-2 py-0.5 text-warning">
                        受限中
                      </span>
                    ) : (
                      <span className="text-muted-foreground">正常</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Link
                      href={`/admin/users/${u.id}`}
                      className="text-xs text-primary hover:underline"
                    >
                      详情 →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pagination basePath={baseQuery({})} page={page} totalPages={totalPages} />
    </div>
  );
}
