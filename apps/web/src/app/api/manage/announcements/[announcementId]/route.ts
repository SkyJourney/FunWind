import "@/modules";
import { ManageApiError } from "@/lib/manage/errors";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";
import { editManageAnnouncement, manageAnnouncementInput } from "@/lib/manage/ops-writes";
import { loadAnnouncementDetail } from "@/lib/announcements/service";

export const dynamic = "force-dynamic";

/** GET /api/manage/announcements/{announcementId}：公告详情（全行含正文；不存在 404） */
export const GET = manageEndpoint(
  async ({ params }) => {
    const { announcementId } = await params;
    const raw = Array.isArray(announcementId) ? announcementId[0] : announcementId;
    // 严格十进制判定：畸形输入一律 404（与 users.detail 同口径）
    if (!/^\d+$/.test(raw ?? "")) throw new ManageApiError("not_found");
    const detail = await loadAnnouncementDetail(Number(raw));
    if (!detail) throw new ManageApiError("not_found");
    return manageOk(detail);
  },
  { endpoint: "announcements.detail" },
);

/** PATCH /api/manage/announcements/{announcementId}：编辑公告（startsAt null 保留原值），幂等写 */
export const PATCH = manageEndpoint(
  async (ctx) => {
    const params = await parseManageWrite(ctx, manageAnnouncementInput, "announcementId");
    return manageOk(await editManageAnnouncement(ctx, params));
  },
  { endpoint: "announcements.edit" },
);
