import "@/modules";
import { ManageApiError } from "@/lib/manage/errors";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import type { ManageHandlerContext } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";
import {
  assignManageUserRole,
  manageUserRoleInput,
  manageUserRoleRevokeInput,
  revokeManageUserRole,
} from "@/lib/manage/system-writes";

export const dynamic = "force-dynamic";

/** 路径 roleKey 形态判定：不符按不存在处理。 */
async function requireRoleKey(ctx: ManageHandlerContext): Promise<string> {
  const raw = (await ctx.params).roleKey;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(value)) {
    throw new ManageApiError("not_found");
  }
  return value;
}

/** PUT /api/manage/users/{uid}/roles/{roleKey}：绑定用户角色（挂 admin.users），幂等写 */
export const PUT = manageEndpoint(
  async (ctx) => {
    const roleKey = await requireRoleKey(ctx);
    const params = await parseManageWrite(ctx, manageUserRoleInput, "uid");
    return manageOk(await assignManageUserRole(ctx, { ...params, roleKey }));
  },
  { endpoint: "users.role-assign" },
);

/** DELETE /api/manage/users/{uid}/roles/{roleKey}：解绑（最后一管理员护栏/联动吊销在服务层），幂等写 */
export const DELETE = manageEndpoint(
  async (ctx) => {
    const roleKey = await requireRoleKey(ctx);
    const params = await parseManageWrite(ctx, manageUserRoleRevokeInput, "uid");
    return manageOk(await revokeManageUserRole(ctx, { ...params, roleKey }));
  },
  { endpoint: "users.role-revoke" },
);
