import { z } from "zod";
import { listContentsPage, resolveContentScope } from "@/lib/moderation/contents";
import { ManageApiError } from "@/lib/manage/errors";
import { manageEndpoint, manageOk, parseManageQuery } from "@/lib/manage/route";
import { managePageField, manageSizeField } from "@/lib/manage/params";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  kind: z.enum(["thread", "reply"]).default("thread"),
  q: z.string().max(128).optional(),
  forumId: z.coerce.number().int().min(1).optional(),
  state: z
    .enum(["all", "visible", "pending", "rejected", "hidden", "deleted", "disabled"])
    .default("all"),
  /** pending 队列语义：queue = 按提交时间正序（先到先审） */
  order: z.enum(["recent", "queue"]).optional(),
  page: managePageField(),
  size: manageSizeField(),
});

/** GET /api/manage/contents：内容管理列表（与后台内容管理页同一 Service 与 scope 判定）。
 * v1 的 token 资格 = 站点管理员不变量，scope 自然为全站视角；版主作用域语义保留在
 * resolveContentScope 内（将来若放宽 token 资格，端点自动正确）。 */
export const GET = manageEndpoint(
  async ({ request, subject }) => {
    const { accessible, scopeForumIds } = await resolveContentScope(subject);
    if (!accessible) throw new ManageApiError("forbidden");
    const q = parseManageQuery(request, querySchema);
    const result = await listContentsPage({
      kind: q.kind,
      q: q.q,
      forumId: q.forumId,
      state: q.state,
      page: q.page ?? 1,
      perPage: q.size !== 20 ? q.size : undefined,
      scopeForumIds,
      order: q.order === "queue" ? "queue" : undefined,
    });
    return manageOk(result);
  },
  { endpoint: "contents" },
);
