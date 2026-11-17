import { requireAdmin } from "@/lib/authz/require-admin";
import { csvRows, queryAuditLogs, queryEventLogs } from "@/lib/admin/logs";

export const dynamic = "force-dynamic";

/** 审计/事件日志 CSV 导出（M9，admin.logs；M19 S4 同步页面新筛选；上限 5000 行——完整分析走数据库） */
export async function GET(request: Request) {
  await requireAdmin("admin.logs");
  const url = new URL(request.url);
  const tab = url.searchParams.get("tab") === "events" ? "events" : "audit";
  const action = url.searchParams.get("action") ?? undefined;
  const actorId = Number(url.searchParams.get("actor") ?? "0") || undefined;
  const from = url.searchParams.get("from") ?? undefined;
  const to = url.searchParams.get("to") ?? undefined;
  const targetType =
    tab === "audit" ? (url.searchParams.get("targetType") ?? undefined) : undefined;
  const filter = {
    action,
    actorId,
    since: from,
    until: to ? `${to} 23:59:59` : undefined,
    targetType,
    limit: 5000,
    offset: 0,
  };

  let csv: string;
  if (tab === "events") {
    const { items } = await queryEventLogs(filter);
    csv = csvRows(
      items.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        action: r.eventName,
        actorId: r.actorId,
        targetType: "event",
        targetId: r.source ?? "",
        detail: r.errorJson ? JSON.stringify(r.errorJson) : "",
      })),
    );
  } else {
    const { items } = await queryAuditLogs(filter);
    csv = csvRows(
      items.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        action: r.action,
        actorId: r.actorId,
        targetType: r.targetType,
        targetId: r.targetId,
        detail: JSON.stringify(r.afterJson ?? r.beforeJson ?? ""),
      })),
    );
  }

  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${tab}-logs.csv"`,
      "x-content-type-options": "nosniff",
    },
  });
}
