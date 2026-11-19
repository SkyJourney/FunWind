import "@/modules";
import { generateManageInvites, manageInviteGenerateInput } from "@/lib/manage/ops-writes";
import { manageEndpoint, manageOk, parseManageQuery } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";
import { listInvitesPage } from "@/lib/admin/invites";
import { managePageField, manageSizeField } from "@/lib/manage/params";
import { z } from "zod";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  status: z.enum(["all", "available", "used", "expired"]).default("all"),
  batch: z.string().max(64).optional(),
  since: z.string().max(10).optional(),
  until: z.string().max(10).optional(),
  page: managePageField(),
  size: manageSizeField(),
});

/** GET /api/manage/invites：邀请码列表（状态/批次/创建时间筛选，与后台同源） */
export const GET = manageEndpoint(
  async ({ request }) => {
    const q = parseManageQuery(request, querySchema);
    const result = await listInvitesPage({
      status: q.status,
      batch: q.batch,
      since: q.since,
      until: q.until,
      page: q.page ?? 1,
      perPage: q.size !== 20 ? q.size : undefined,
    });
    return manageOk(result);
  },
  { endpoint: "invites" },
);

/** POST /api/manage/invites：批量生成邀请码（≤20/次），幂等写（同键回放返回同一批码） */
export const POST = manageEndpoint(
  async (ctx) => {
    const params = await parseManageWrite(ctx, manageInviteGenerateInput);
    return manageOk(await generateManageInvites(ctx, params));
  },
  { endpoint: "invites.generate" },
);
