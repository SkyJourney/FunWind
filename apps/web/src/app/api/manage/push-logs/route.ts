import { z } from "zod";
import { ADMIN_PAGE_SIZES } from "@/lib/admin/query";
import { pushLogSummary, queryPushLogs } from "@/lib/push/log-query";
import { manageEndpoint, manageOk, parseManageQuery } from "@/lib/manage/route";

export const dynamic = "force-dynamic";

/** 推送日志场景键白名单（M18 三类）；记录不含推送 payload 正文 */
const querySchema = z.object({
  status: z.enum(["sent", "failed"]).optional(),
  scene: z.enum(["pm-received", "post-replied", "post-mentioned"]).optional(),
  /** 纯数字按 userId 等值，否则订阅 endpoint 包含 */
  q: z.string().max(128).optional(),
  page: z.coerce.number().int().min(1).optional(),
  size: z.coerce
    .number()
    .int()
    .refine((v) => (ADMIN_PAGE_SIZES as readonly number[]).includes(v), "size 档位非法")
    .optional(),
});

/** GET /api/manage/push-logs：推送日志分页 + 近 24h 成败摘要（与后台推送记录页同一查询层） */
export const GET = manageEndpoint(
  async ({ request }) => {
    const q = parseManageQuery(request, querySchema);
    const [logs, summary] = await Promise.all([
      queryPushLogs({ status: q.status, scene: q.scene, q: q.q, page: q.page, limit: q.size }),
      pushLogSummary(),
    ]);
    return manageOk({ ...logs, summary });
  },
  { endpoint: "push-logs", permission: "admin.logs" },
);
