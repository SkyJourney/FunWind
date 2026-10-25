import Link from "next/link";
import { requireAdmin } from "@/lib/authz/require-admin";
import { searchUsers } from "@/lib/authz/restrictions-admin";
import { Card, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";
export const metadata = { title: "用户管理" };

type Params = { searchParams: Promise<{ q?: string }> };

/** 用户搜索（M9，admin.users）：按用户名包含匹配，结果链到详情页 */
export default async function AdminUsersPage({ searchParams }: Params) {
  await requireAdmin("admin.users");
  const q = typeof (await searchParams).q === "string" ? (await searchParams).q! : "";
  const users = q ? await searchUsers(q) : [];

  return (
    <div className="space-y-4">
      <form action="/admin/users" method="get" className="flex gap-2">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="用户名（包含匹配）"
          className="flex-1 rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        <button
          type="submit"
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          搜索
        </button>
      </form>

      {q && users.length === 0 && (
        <p className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
          没有匹配「{q}」的用户。
        </p>
      )}

      {users.length > 0 && (
        <Card>
          <CardContent className="pt-6">
            <ul className="divide-y">
              {users.map((u) => (
                <li key={u.id} className="flex items-center justify-between py-2.5 text-sm">
                  <div>
                    <Link href={`/admin/users/${u.id}`} className="font-medium hover:text-primary">
                      {u.username}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      uid {u.id} · 注册于 {u.createdAt} · 主题 {Number(u.threadCount)} · 帖子{" "}
                      {Number(u.postCount)}
                    </p>
                  </div>
                  <Link
                    href={`/admin/users/${u.id}`}
                    className="text-xs text-primary hover:underline"
                  >
                    详情 →
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-muted-foreground">
        提示：旧库迁移遗留 6 组重复邮箱（保留最早注册者，其余置空）需人工线下处理——清单见私有报告
        migration/reports/migration-v2-todo-pii.md（含真实邮箱，不入库）。
      </p>
    </div>
  );
}
