import { z } from "zod";
import { ADMIN_PAGE_SIZES } from "@/lib/admin/query";
import { queryAuditLogs, resolveActorId } from "@/lib/admin/logs";
import { manageEndpoint, manageOk, parseManageQuery } from "@/lib/manage/route";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  action: z.string().max(64).optional(),
  /** 纯数字按 uid 等值，否则按用户名精确反查；查无此人 → 空结果（与后台日志页同语义） */
  actor: z.string().max(64).optional(),
  targetType: z.string().max(32).optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "from 需为 YYYY-MM-DD")
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "to 需为 YYYY-MM-DD")
    .optional(),
  page: z.coerce.number().int().min(1).optional(),
  size: z.coerce
    .number()
    .int()
    .refine((v) => (ADMIN_PAGE_SIZES as readonly number[]).includes(v), "size 档位非法")
    .optional(),
});

/** GET /api/manage/audit-logs：审计日志检索（与后台审计日志页同一查询层） */
export const GET = manageEndpoint(
  async ({ request }) => {
    const q = parseManageQuery(request, querySchema);
    const actorId = q.actor !== undefined ? await resolveActorId(q.actor) : undefined;
    const result = await queryAuditLogs({
      action: q.action,
      actorId,
      targetType: q.targetType,
      since: q.from !== undefined ? `${q.from} 00:00:00` : undefined,
      until: q.to !== undefined ? `${q.to} 23:59:59` : undefined,
      page: q.page,
      limit: q.size,
    });
    return manageOk(result);
  },
  { endpoint: "audit-logs", permission: "admin.logs" },
);
