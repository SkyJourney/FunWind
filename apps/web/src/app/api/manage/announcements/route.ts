import "@/modules";
import { createManageAnnouncement, manageAnnouncementInput } from "@/lib/manage/ops-writes";
import { manageEndpoint, manageOk, parseManageQuery } from "@/lib/manage/route";
import { managePageField, manageSizeField } from "@/lib/manage/params";
import { parseManageWrite } from "@/lib/manage/write-request";
import { listAnnouncementsPage } from "@/lib/announcements/service";
import { z } from "zod";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  q: z.string().max(128).optional(),
  status: z.enum(["all", "scheduled", "active", "ended"]).default("all"),
  page: managePageField(),
  size: manageSizeField(),
});

/** GET /api/manage/announcements：公告列表（全状态可见，标题与窗口状态筛选） */
export const GET = manageEndpoint(
  async ({ request }) => {
    const q = parseManageQuery(request, querySchema);
    const result = await listAnnouncementsPage({
      q: q.q,
      status: q.status === "all" ? undefined : q.status,
      page: q.page ?? 1,
      perPage: q.size !== 20 ? q.size : undefined,
    });
    return manageOk(result);
  },
  { endpoint: "announcements" },
);

/** POST /api/manage/announcements：发布公告（startsAt null = 立即开始），幂等写 */
export const POST = manageEndpoint(
  async (ctx) => {
    const params = await parseManageWrite(ctx, manageAnnouncementInput);
    return manageOk(await createManageAnnouncement(ctx, params));
  },
  { endpoint: "announcements.create" },
);
