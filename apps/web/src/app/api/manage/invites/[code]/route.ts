import "@/modules";
import { z } from "zod";
import { ManageApiError } from "@/lib/manage/errors";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import type { ManageHandlerContext } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";
import { revokeManageInvite } from "@/lib/manage/ops-writes";

export const dynamic = "force-dynamic";

/** 路径 code 形态判定（码面字符集，列宽 varchar(32)）：不符按不存在处理，不泄露资源语义。 */
async function requireCode(ctx: ManageHandlerContext): Promise<string> {
  const { code } = await ctx.params;
  if (typeof code !== "string" || !/^[A-Za-z0-9-]{4,32}$/.test(code)) {
    throw new ManageApiError("not_found");
  }
  return code;
}

/** DELETE 请求体保持空对象：code 由路径注入参与幂等指纹。 */
const codeBody = z.strictObject({});

/** DELETE /api/manage/invites/{code}：吊销单条未用邀请码，幂等写 */
export const DELETE = manageEndpoint(
  async (ctx) => {
    const code = await requireCode(ctx);
    const params = await parseManageWrite(ctx, codeBody);
    void params.targetId;
    return manageOk(
      await revokeManageInvite(ctx, {
        targetId: 0,
        idempotencyKey: params.idempotencyKey,
        input: { code },
      }),
    );
  },
  { endpoint: "invites.revoke" },
);
