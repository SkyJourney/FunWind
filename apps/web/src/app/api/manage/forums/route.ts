import "@/modules";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";
import { createManageForum, manageForumCreateInput } from "@/lib/manage/community-writes";
import { listForumRows } from "@/lib/forums/admin";

export const dynamic = "force-dynamic";

/** GET /api/manage/forums：版块列表（含归档全量，树形由 path/depth 表达） */
export const GET = manageEndpoint(async () => manageOk({ items: await listForumRows() }), {
  endpoint: "forums",
});

/** POST /api/manage/forums：创建版块/分组（父子深度自动计算），幂等写 */
export const POST = manageEndpoint(
  async (ctx) => {
    const params = await parseManageWrite(ctx, manageForumCreateInput);
    void params.targetId;
    return manageOk(await createManageForum(ctx, params));
  },
  { endpoint: "forums.create" },
);
