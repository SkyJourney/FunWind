import "@/modules";
import { z } from "zod";
import { ManageApiError } from "@/lib/manage/errors";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";
import { removeManageForumPrefix } from "@/lib/manage/community-writes";

export const dynamic = "force-dynamic";

/** DELETE /api/manage/forums/{fid}/prefixes/{prefixId}：移除前缀（归属锁在服务层），幂等写 */
export const DELETE = manageEndpoint(
  async (ctx) => {
    const raw = (await ctx.params).prefixId;
    const prefixId = Array.isArray(raw) ? raw[0] : raw;
    if (typeof prefixId !== "string" || !/^\d+$/.test(prefixId)) {
      throw new ManageApiError("not_found");
    }
    const params = await parseManageWrite(ctx, z.strictObject({}), "fid");
    void params.targetId;
    return manageOk(
      await removeManageForumPrefix(ctx, {
        targetId: params.targetId,
        idempotencyKey: params.idempotencyKey,
        prefixId: Number(prefixId),
      }),
    );
  },
  { endpoint: "forums.prefix-remove" },
);
