import { z } from "zod";
import { loadContentDetail, resolveContentScope } from "@/lib/moderation/contents";
import { ManageApiError } from "@/lib/manage/errors";
import { manageEndpoint, manageOk, parseManageQuery } from "@/lib/manage/route";

export const dynamic = "force-dynamic";

const querySchema = z.object({ kind: z.enum(["thread", "reply"]).default("thread") });

/** GET /api/manage/contents/[id]?kind=thread|reply：内容行级详情（主题含首帖正文）；
 * 越权与不存在一律 404（存在性不泄露） */
export const GET = manageEndpoint(
  async ({ request, params, subject }) => {
    const { accessible, scopeForumIds } = await resolveContentScope(subject);
    if (!accessible) throw new ManageApiError("forbidden");
    const q = parseManageQuery(request, querySchema);
    const { id } = await params;
    const raw = Array.isArray(id) ? id[0] : id;
    // 严格十进制判定：Number() 会放行 "0x10"/"1e2"/带空白等畸形输入
    if (!/^\d+$/.test(raw ?? "")) throw new ManageApiError("not_found");
    const numeric = Number(raw);
    const result = await loadContentDetail(q.kind, numeric, scopeForumIds);
    if (!result.ok) throw new ManageApiError("not_found");
    return manageOk(result.detail);
  },
  { endpoint: "contents.detail" },
);
