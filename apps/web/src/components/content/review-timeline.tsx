import { Clock } from "lucide-react";
import { fmtDateTime } from "@/lib/admin/format";

/**
 * 审核历史时间线（M9.5 §9.2-G1）：content_reviews 全量行（通过/驳回/封禁）——
 * 底层表一直每次留行，此前只读最新一条；此处给作者与版主一个完整时间线。
 */
export function ReviewTimeline({
  entries,
}: {
  entries: {
    id: number;
    decision: string;
    note: string;
    reviewerName: string | null;
    createdAt: string;
  }[];
}) {
  if (entries.length === 0) return null;
  const LABEL: Record<string, string> = {
    approved: "通过",
    rejected: "驳回",
    disabled: "封禁",
  };
  const CLS: Record<string, string> = {
    approved: "text-success",
    rejected: "text-destructive",
    disabled: "text-destructive",
  };
  return (
    <section
      aria-label="审核历史"
      className="rounded-xl border bg-card p-4 text-sm"
      data-testid="review-timeline"
    >
      <h2 className="mb-2 flex items-center gap-1.5 font-semibold">
        <Clock className="size-4" aria-hidden /> 审核历史（{entries.length}）
      </h2>
      <ol className="space-y-1.5">
        {entries.map((e) => (
          <li key={e.id} className="flex flex-wrap items-baseline gap-x-2 text-xs">
            <span className="text-muted-foreground">{fmtDateTime(e.createdAt)}</span>
            <span className={`font-medium ${CLS[e.decision] ?? ""}`}>
              {LABEL[e.decision] ?? e.decision}
            </span>
            <span className="text-muted-foreground">by {e.reviewerName ?? "已注销"}</span>
            {e.note && <span className="text-muted-foreground">理由：{e.note}</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}
