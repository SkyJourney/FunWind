import "@/modules";
import { ManageApiError } from "@/lib/manage/errors";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";
import { manageSessionRevokeInput, revokeManageUserSession } from "@/lib/manage/user-writes";
import type { ManageHandlerContext } from "@/lib/manage/route";

export const dynamic = "force-dynamic";

/** 路径 sessionId 形态判定（64 位 hex）：不符按不存在处理，不泄露资源语义。 */
async function requireSessionId(ctx: ManageHandlerContext): Promise<string> {
  const { sessionId } = await ctx.params;
  if (typeof sessionId !== "string" || !/^[0-9a-f]{64}$/.test(sessionId)) {
    throw new ManageApiError("not_found");
  }
  return sessionId;
}

/** DELETE /api/manage/users/{uid}/sessions/{sessionId}：吊销一台登录会话，幂等写 */
export const DELETE = manageEndpoint(
  async (ctx) => {
    const sessionId = await requireSessionId(ctx);
    // targetId = uid 参与指纹；sessionId 由路径注入请求体，同键异会话不会误命中回放
    const params = await parseManageWrite(ctx, manageSessionRevokeInput, "uid");
    return manageOk(await revokeManageUserSession(ctx, { ...params, input: { sessionId } }));
  },
  { endpoint: "users.revoke-session" },
);
