import "@/modules";
import { ManageApiError } from "@/lib/manage/errors";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import type { ManageHandlerContext } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";
import {
  grantManageRole,
  manageRoleGrantInput,
  revokeManageRole,
} from "@/lib/manage/system-writes";

export const dynamic = "force-dynamic";

const ROLE_KEY_PATH_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PERMISSION_PATH_RE = /^[a-zA-Z0-9]+(\.[a-zA-Z0-9]+)*$/;

async function requireParam(ctx: ManageHandlerContext, key: string): Promise<string> {
  const raw = (await ctx.params)[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const re = key === "roleKey" ? ROLE_KEY_PATH_RE : PERMISSION_PATH_RE;
  if (typeof value !== "string" || !re.test(value)) throw new ManageApiError("not_found");
  return value;
}

/** PUT /api/manage/roles/{roleKey}/grants/{permission}：授予（提权护栏在服务层），幂等写 */
export const PUT = manageEndpoint(
  async (ctx) => {
    const roleKey = await requireParam(ctx, "roleKey");
    const permissionKey = await requireParam(ctx, "permission");
    // 无数字目标（roleKey/permission 均为路径字符串）：targetId 记 0，二者注入请求体参与幂等指纹
    const params = await parseManageWrite(ctx, manageRoleGrantInput);
    return manageOk(
      await grantManageRole(ctx, {
        targetId: 0,
        idempotencyKey: params.idempotencyKey,
        input: { ...params.input, roleKey, permissionKey },
      }),
    );
  },
  { endpoint: "roles.grant" },
);

/** DELETE /api/manage/roles/{roleKey}/grants/{permission}：撤销（防自锁/联动吊销在服务层），幂等写 */
export const DELETE = manageEndpoint(
  async (ctx) => {
    const roleKey = await requireParam(ctx, "roleKey");
    const permissionKey = await requireParam(ctx, "permission");
    const params = await parseManageWrite(ctx, manageRoleGrantInput);
    void params.targetId;
    return manageOk(
      await revokeManageRole(ctx, {
        targetId: 0,
        idempotencyKey: params.idempotencyKey,
        input: { ...params.input, roleKey, permissionKey },
      }),
    );
  },
  { endpoint: "roles.revoke" },
);
