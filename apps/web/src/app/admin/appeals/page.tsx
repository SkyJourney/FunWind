import Link from "next/link";
import { requireAdmin } from "@/lib/authz/require-admin";
import { listPendingUserAppeals } from "@/lib/authz/appeals";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { fmtDateTime } from "@/lib/admin/format";
import { resolveUserAppealAction } from "../users/actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "申诉复核" };

export default async function AdminAppealsPage() {
  await requireAdmin("admin.users");
  const appeals = await listPendingUserAppeals();
  return (
    <main className="mx-auto max-w-5xl space-y-4 px-4 py-8 sm:px-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">申诉复核</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          按提交时间排列；每项由授权治理人员人工处理。
        </p>
      </header>
      <Card>
        <CardHeader>
          <CardTitle>待处理（{appeals.length}）</CardTitle>
        </CardHeader>
        <CardContent>
          {appeals.length === 0 ? (
            <p className="text-sm text-muted-foreground">当前没有待处理申诉。</p>
          ) : (
            <ul className="divide-y">
              {appeals.map((appeal) => (
                <li key={appeal.id} className="space-y-3 py-4">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                    <Link
                      href={`/admin/users/${appeal.userId}`}
                      className="font-medium text-primary hover:underline"
                    >
                      {appeal.username ?? "未知用户"} · UID {appeal.userId}
                    </Link>
                    <span className="text-muted-foreground">
                      {fmtDateTime(appeal.createdAt)} ·{" "}
                      {appeal.targetType === "restriction" ? "限制" : "注销申请"} #{appeal.targetId}
                    </span>
                  </div>
                  <p className="text-sm whitespace-pre-wrap">{appeal.reason}</p>
                  {appeal.userDeleted ? (
                    <p className="text-xs text-muted-foreground">
                      账号已注销；此申诉保留为只读历史。
                    </p>
                  ) : (
                    <form action={resolveUserAppealAction} className="flex flex-wrap gap-2">
                      <input type="hidden" name="userId" value={appeal.userId} />
                      <input type="hidden" name="appealId" value={appeal.id} />
                      <select
                        name="status"
                        aria-label="申诉处理决定"
                        className="rounded-lg border bg-background px-2 py-1"
                      >
                        <option value="approved">通过</option>
                        <option value="rejected">驳回</option>
                      </select>
                      <input
                        name="result"
                        required
                        maxLength={1000}
                        placeholder="处理结果（必填）"
                        className="min-w-56 flex-1 rounded-lg border bg-background px-2.5 py-1"
                      />
                      <SubmitButton pendingText="处理中…" className="rounded-lg border px-3 py-1">
                        保存结果
                      </SubmitButton>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
