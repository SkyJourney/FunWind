import "@/modules";
import { endManageAnnouncement, manageAnnouncementEndInput } from "@/lib/manage/ops-writes";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";

export const dynamic = "force-dynamic";

/** POST /api/manage/announcements/{announcementId}/end：下线公告（ends_at 置当前时刻），幂等写 */
export const POST = manageEndpoint(
  async (ctx) => {
    const params = await parseManageWrite(ctx, manageAnnouncementEndInput, "announcementId");
    return manageOk(await endManageAnnouncement(ctx, params));
  },
  { endpoint: "announcements.end" },
);
