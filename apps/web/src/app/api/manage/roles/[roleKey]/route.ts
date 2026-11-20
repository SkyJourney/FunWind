import "@/modules";
import { z } from "zod";
import { ManageApiError } from "@/lib/manage/errors";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import type { ManageHandlerContext } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";
import { deleteManageRole } from "@/lib/manage/system-writes";
import { getRoleGrants, listPermissions, listRoles } from "@/lib/authz/admin";

export const dynamic = "force-dynamic";

/** 路径 roleKey 形态判定（角色键为英文标识）：不符按不存在处理。 */
async function requireRoleKey(ctx: ManageHandlerContext, key: string): Promise<string> {
  const raw = (await ctx.params)[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(value)) {
    throw new ManageApiError("not_found");
  }
  return value;
}

/** GET /api/manage/roles/{roleKey}：角色详情（现有授权 + 可授权限词汇表） */
export const GET = manageEndpoint(
  async (ctx) => {
    const roleKey = await requireRoleKey(ctx, "roleKey");
    const roles = await listRoles();
    const role = roles.find((r) => r.key === roleKey);
    if (!role) throw new ManageApiError("not_found");
    return manageOk({
      ...role,
      grants: await getRoleGrants(roleKey),
      permissions: await listPermissions(),
    });
  },
  { endpoint: "roles.detail" },
);

/** DELETE /api/manage/roles/{roleKey}：删除自定义角色（内置 409、护栏 409），幂等写 */
export const DELETE = manageEndpoint(
  async (ctx) => {
    const roleKey = await requireRoleKey(ctx, "roleKey");
    // 无数字目标（roleKey 为路径字符串）：targetId 记 0，roleKey 注入参与幂等指纹
    const params = await parseManageWrite(ctx, z.strictObject({}));
    void params.targetId;
    return manageOk(
      await deleteManageRole(ctx, {
        targetId: 0,
        idempotencyKey: params.idempotencyKey,
        roleKey,
      }),
    );
  },
  { endpoint: "roles.delete" },
);
