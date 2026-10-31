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
  searchParams: Promise<{
    q?: string;
    status?: string;
    lifecycle?: string;
    credential?: string;
    sort?: string;
    page?: string;
  }>;
};

const SORTS = [
  { key: "recent", label: "最新注册" },
  { key: "id", label: "uid 顺序" },
  { key: "threads", label: "主题最多" },
] as const;

const LIFECYCLES = [
  { key: "active", label: "活跃账号" },
  { key: "closure_pending", label: "注销申请中" },
  { key: "deleted", label: "已注销 / 占位" },
  { key: "all", label: "全部生命周期" },
] as const;

const CREDENTIALS = [
  { key: "all", label: "全部凭据" },
  { key: "email_unverified", label: "邮箱待验证" },
  { key: "no_password", label: "待认领 / 无密码" },
  { key: "legacy_password_pending", label: "待强制换密" },
] as const;

/** 用户管理列表（M9.5 重做）：默认列最近注册，关键词（uid 等值/用户名包含）+ 受限筛选 + 排序 + 分页。 */
export default async function AdminUsersPage({ searchParams }: Params) {
  await requireAdmin("admin.users");
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : "";
  const status = sp.status === "restricted" ? "restricted" : "all";
  const lifecycle = LIFECYCLES.some((filter) => filter.key === sp.lifecycle)
    ? (sp.lifecycle as "active" | "closure_pending" | "deleted" | "all")
    : "active";
  const credential = CREDENTIALS.some((filter) => filter.key === sp.credential)
    ? (sp.credential as "all" | "email_unverified" | "no_password" | "legacy_password_pending")
    : "all";
  const sort = SORTS.some((s) => s.key === sp.sort)
    ? (sp.sort as "recent" | "id" | "threads")
    : "recent";
  const page = Number(sp.page ?? "1") || 1;

  const {
    items,
    total,
    page: safePage,
    totalPages,
  } = await listAdminUsersPage({ q, status, lifecycle, credential, sort }, page);

  const baseQuery = (over: Record<string, string>) => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (status !== "all") p.set("status", status);
    if (lifecycle !== "active") p.set("lifecycle", lifecycle);
    if (credential !== "all") p.set("credential", credential);
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
            name="lifecycle"
            defaultValue={lifecycle}
            aria-label="账号生命周期"
            className="rounded-lg border border-input bg-background px-2 py-1.5 text-sm"
          >
            {LIFECYCLES.map((filter) => (
              <option key={filter.key} value={filter.key}>
                {filter.label}
              </option>
            ))}
          </select>
          <select
            name="credential"
            defaultValue={credential}
            aria-label="凭据状态"
            className="rounded-lg border border-input bg-background px-2 py-1.5 text-sm"
          >
            {CREDENTIALS.map((filter) => (
              <option key={filter.key} value={filter.key}>
                {filter.label}
              </option>
            ))}
          </select>
          <select
            name="status"
            defaultValue={status}
            aria-label="限制状态"
            className="rounded-lg border border-input bg-background px-2 py-1.5 text-sm"
          >
            <option value="all">全部限制</option>
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
        <div className="flex items-center gap-3">
          <Link href="/admin/appeals" className="text-xs text-primary hover:underline">
            申诉复核
          </Link>
          <p className="text-xs text-muted-foreground">共 {total} 人</p>
        </div>
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={Users}
          title={
            q || status !== "all" || lifecycle !== "active" || credential !== "all"
              ? "没有匹配条件的用户。"
              : "还没有注册用户。"
          }
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
                    <div className="flex flex-wrap gap-1.5">
                      {u.state === "deleted" ? (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
                          已注销
                        </span>
                      ) : u.closurePending ? (
                        <span className="rounded-full bg-warning/10 px-2 py-0.5 text-warning">
                          注销申请中
                        </span>
                      ) : (
                        <span className="text-muted-foreground">活跃</span>
                      )}
                      {u.emailVerificationRequired && !u.emailVerified && (
                        <span className="rounded-full bg-warning/10 px-2 py-0.5 text-warning">
                          待验证
                        </span>
                      )}
                      {!u.hasPassword && (
                        <span className="rounded-full border px-2 py-0.5 text-muted-foreground">
                          待认领
                        </span>
                      )}
                      {u.legacyPasswordPending && (
                        <span className="rounded-full border px-2 py-0.5 text-muted-foreground">
                          待换密
                        </span>
                      )}
                      {u.restricted && (
                        <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-destructive">
                          受限
                        </span>
                      )}
                      {u.closureScheduledAt && (
                        <span className="text-muted-foreground">
                          到期 {fmtDateTime(u.closureScheduledAt)}
                        </span>
                      )}
                    </div>
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

      <Pagination basePath={baseQuery({})} page={safePage} totalPages={totalPages} />
    </div>
  );
}
