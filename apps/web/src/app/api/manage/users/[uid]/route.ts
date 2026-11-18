import "@/modules"; // 传递依赖触及内核事件总线（admin-user-views → authz/admin → outbox），按硬约定 9 显式注册

import { checkPermission } from "@/lib/authz/service";
import { adminUserDetail } from "@/lib/authz/admin-user-views";
import { ManageApiError } from "@/lib/manage/errors";
import { manageEndpoint, manageOk } from "@/lib/manage/route";

export const dynamic = "force-dynamic";

/** GET /api/manage/users/[uid]：用户详情三签聚合（资料/邮箱/积分/角色/限制/申诉/会话/审计）；
 * IP 字段由调用方 user.viewIp 权限决定（与后台用户页同语义） */
export const GET = manageEndpoint(
  async ({ params, subject }) => {
    const { uid } = await params;
    const raw = Array.isArray(uid) ? uid[0] : uid;
    // 严格十进制判定：Number() 会放行 "0x10"/"1e2"/带空白等畸形输入
    if (!/^\d+$/.test(raw ?? "")) throw new ManageApiError("not_found");
    const id = Number(raw);
    const includeIp = (await checkPermission(subject, "user.viewIp")).allowed;
    const detail = await adminUserDetail(id, includeIp);
    if (!detail) throw new ManageApiError("not_found");
    return manageOk(detail);
  },
  { endpoint: "users.detail" },
);
