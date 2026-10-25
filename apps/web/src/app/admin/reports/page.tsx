import Link from "next/link";
import { requireAdmin } from "@/lib/authz/require-admin";
import { reportQueue } from "@/lib/reports/service";
import { SubmitButton } from "@/components/ui/submit-button";
import { handleReportAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "举报处理" };

type Params = {
  searchParams: Promise<{ tab?: string; error?: string; resolved?: string; dismissed?: string }>;
};

const TABS = [
  { key: "pending" as const, label: "待处理" },
  { key: "resolved" as const, label: "已处置" },
  { key: "dismissed" as const, label: "已忽略" },
];

/** 举报队列（M9，admin.reports）：状态筛选 + 处理/忽略（说明回给举报人通知）。 */
export default async function AdminReportsPage({ searchParams }: Params) {
  await requireAdmin("admin.reports");
  const sp = await searchParams;
  const tab = TABS.some((t) => t.key === sp.tab)
    ? (sp.tab as "pending" | "resolved" | "dismissed")
    : "pending";
  const items = await reportQueue(tab);

  return (
    <div className="space-y-4">
      {sp.error && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {sp.error}
        </p>
      )}
      {(sp.resolved || sp.dismissed) && (
        <p className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
          已{sp.resolved ? "处置" : "忽略"}（举报人会收到处理说明）。
        </p>
      )}

      <nav className="flex gap-2 text-sm" aria-label="举报状态">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/admin/reports?tab=${t.key}`}
            className={`rounded-full border px-3 py-1 ${tab === t.key ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {items.length === 0 ? (
        <p className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
          该状态下没有举报。
        </p>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.id} className="rounded-xl border bg-card px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    <Link href={`/t/${item.threadId}`} className="hover:text-primary">
                      {item.threadTitle}
                    </Link>
                    <span className="ml-1 text-xs text-muted-foreground">
                      （帖子 #{item.postId}）
                    </span>
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {item.reporterName ?? "已注销"} 举报于 {item.createdAt}：{item.reason}
                  </p>
                </div>
                {tab === "pending" && (
                  <div className="flex flex-wrap gap-2">
                    <form action={handleReportAction} className="flex items-center gap-1">
                      <input type="hidden" name="reportId" value={item.id} />
                      <input type="hidden" name="outcome" value="resolved" />
                      <input
                        name="note"
                        required
                        maxLength={255}
                        placeholder="处理说明（回给举报人）"
                        className="w-48 rounded-lg border bg-background px-2.5 py-1.5 text-sm"
                      />
                      <SubmitButton
                        className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                        pendingText="…"
                      >
                        处置
                      </SubmitButton>
                    </form>
                    <form action={handleReportAction}>
                      <input type="hidden" name="reportId" value={item.id} />
                      <input type="hidden" name="outcome" value="dismissed" />
                      <input type="hidden" name="note" value="经核实不构成违规" />
                      <SubmitButton
                        className="rounded-lg border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-60"
                        pendingText="…"
                      >
                        忽略
                      </SubmitButton>
                    </form>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
