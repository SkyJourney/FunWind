import { z } from "zod";
import { ADMIN_PAGE_SIZES } from "@/lib/admin/query";
import { emailLogSummary, queryEmailLogs } from "@/lib/mail/log-query";
import { manageEndpoint, manageOk, parseManageQuery } from "@/lib/manage/route";

export const dynamic = "force-dynamic";

/** 邮件日志场景键白名单（与 lib/mail/log-query 的过滤语义一致，此处 zod 严格校验：非法即 400） */
const querySchema = z.object({
  status: z.enum(["sent", "failed"]).optional(),
  kind: z.enum(["verify", "security", "notice", "digest", "system"]).optional(),
  scene: z
    .string()
    .regex(/^[a-z0-9-]{1,48}$/)
    .optional(),
  /** 纯数字按 userId 等值，否则收件地址包含 */
  q: z.string().max(128).optional(),
  page: z.coerce.number().int().min(1).optional(),
  size: z.coerce
    .number()
    .int()
    .refine((v) => (ADMIN_PAGE_SIZES as readonly number[]).includes(v), "size 档位非法")
    .optional(),
});

/** GET /api/manage/emails：邮件日志分页 + 近 24h 成败摘要（与后台邮件页同一查询层） */
export const GET = manageEndpoint(
  async ({ request }) => {
    const q = parseManageQuery(request, querySchema);
    const [logs, summary] = await Promise.all([
      queryEmailLogs({
        status: q.status,
        kind: q.kind,
        scene: q.scene,
        q: q.q,
        page: q.page,
        limit: q.size,
      }),
      emailLogSummary(),
    ]);
    return manageOk({ ...logs, summary });
  },
  { endpoint: "emails", permission: "admin.logs" },
);
