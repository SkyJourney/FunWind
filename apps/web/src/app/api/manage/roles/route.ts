import "@/modules";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";
import { createManageRole, manageRoleCreateInput } from "@/lib/manage/system-writes";
import { listRoles } from "@/lib/authz/admin";

export const dynamic = "force-dynamic";

/** GET /api/manage/roles：角色列表（含授权数与持有人数聚合） */
export const GET = manageEndpoint(async () => manageOk({ items: await listRoles() }), {
  endpoint: "roles",
});

/** POST /api/manage/roles：创建自定义角色（key 唯一），幂等写 */
export const POST = manageEndpoint(
  async (ctx) => {
    const params = await parseManageWrite(ctx, manageRoleCreateInput);
    void params.targetId;
    return manageOk(await createManageRole(ctx, params));
  },
  { endpoint: "roles.create" },
);
