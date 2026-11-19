import "@/modules";
import { z } from "zod";
import { manageEndpoint, manageOk, parseManageQuery } from "@/lib/manage/route";
import { managePageField, manageSizeField } from "@/lib/manage/params";
import { listPollPage } from "@/lib/poll/admin";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  status: z.enum(["all", "open", "closed"]).default("all"),
  forumId: z.coerce.number().int().min(1).optional(),
  page: managePageField(),
  size: manageSizeField(),
});

/** GET /api/manage/polls：投票列表（状态由 endsAt 派生，含选项/票数聚合） */
export const GET = manageEndpoint(
  async ({ request }) => {
    const q = parseManageQuery(request, querySchema);
    const result = await listPollPage({
      status: q.status,
      forumId: q.forumId,
      page: q.page ?? 1,
      perPage: q.size !== 20 ? q.size : undefined,
      // REST 调用者恒为站点管理员（guard 基线），全站视角
      moderated: null,
    });
    return manageOk(result);
  },
  { endpoint: "polls" },
);
