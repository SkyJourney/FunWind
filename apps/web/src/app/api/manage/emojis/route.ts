import "@/modules";
import { z } from "zod";
import { manageEndpoint, manageOk, parseManageQuery } from "@/lib/manage/route";
import { managePageField, manageSizeField } from "@/lib/manage/params";
import { listEmojiGroupsAdmin, listEmojisAdminPage } from "@/lib/emoji/service";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  groupId: z.coerce.number().int().min(1).optional(),
  q: z.string().max(64).optional(),
  page: managePageField(),
  size: manageSizeField(),
});

/** GET /api/manage/emojis：表情组全量（含停用）+ 表情分页（管理视角） */
export const GET = manageEndpoint(
  async ({ request }) => {
    const q = parseManageQuery(request, querySchema);
    const [groups, emojis] = await Promise.all([
      listEmojiGroupsAdmin(),
      listEmojisAdminPage({
        groupId: q.groupId,
        q: q.q,
        page: q.page ?? 1,
        perPage: q.size !== 50 ? q.size : undefined,
      }),
    ]);
    return manageOk({ groups, ...emojis });
  },
  { endpoint: "emojis" },
);
