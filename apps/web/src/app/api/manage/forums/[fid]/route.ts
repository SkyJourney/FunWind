import "@/modules";
import { z } from "zod";
import { ManageApiError } from "@/lib/manage/errors";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import type { ManageHandlerContext } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";
import {
  deleteManageForum,
  manageForumUpdateInput,
  updateManageForum,
} from "@/lib/manage/community-writes";
import { listForumRows } from "@/lib/forums/admin";

export const dynamic = "force-dynamic";

/** 严格十进制路径 fid：畸形输入按不存在处理。 */
async function requireFid(ctx: ManageHandlerContext, key: string): Promise<number> {
  const raw = (await ctx.params)[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new ManageApiError("not_found");
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) throw new ManageApiError("not_found");
  return numeric;
}

/** GET /api/manage/forums/{fid}：版块详情（含策略与前缀） */
export const GET = manageEndpoint(
  async (ctx) => {
    const fid = await requireFid(ctx, "fid");
    const row = (await listForumRows()).find((r) => r.id === fid);
    if (!row) throw new ManageApiError("not_found");
    return manageOk(row);
  },
  { endpoint: "forums.detail" },
);

/** PATCH /api/manage/forums/{fid}：编辑版块（子树迁移 + 环检测），幂等写 */
export const PATCH = manageEndpoint(
  async (ctx) => {
    const params = await parseManageWrite(ctx, manageForumUpdateInput, "fid");
    return manageOk(await updateManageForum(ctx, params));
  },
  { endpoint: "forums.edit" },
);

/** DELETE /api/manage/forums/{fid}：删除空版块（双守卫），幂等写 */
export const DELETE = manageEndpoint(
  async (ctx) => {
    const fid = await requireFid(ctx, "fid");
    const params = await parseManageWrite(ctx, z.strictObject({}), "fid");
    void params.targetId;
    return manageOk(
      await deleteManageForum(ctx, {
        targetId: fid,
        idempotencyKey: params.idempotencyKey,
        input: {},
      }),
    );
  },
  { endpoint: "forums.delete" },
);
