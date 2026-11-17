import "@/modules"; // 传递依赖触及内核事件总线（admin-user-views → authz/admin → outbox），按硬约定 9 显式注册

import { z } from "zod";
import { ADMIN_PAGE_SIZES } from "@/lib/admin/query";
import { listAdminUsersPage } from "@/lib/authz/admin-user-views";
import { manageEndpoint, manageOk, parseManageQuery } from "@/lib/manage/route";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  /** 纯数字按 uid 等值，否则用户名包含 */
  q: z.string().max(64).optional(),
  status: z.enum(["all", "restricted"]).optional(),
  lifecycle: z.enum(["active", "closure_pending", "deleted", "all"]).optional(),
  credential: z
    .enum(["all", "email_unverified", "no_password", "legacy_password_pending"])
    .optional(),
  sort: z.enum(["recent", "id", "threads"]).default("recent"),
  page: z.coerce.number().int().min(1).optional(),
  size: z.coerce
    .number()
    .int()
    .refine((v) => (ADMIN_PAGE_SIZES as readonly number[]).includes(v), "size 档位非法")
    .optional(),
});

/** GET /api/manage/users：用户治理列表（与后台用户页同源筛选语义） */
export const GET = manageEndpoint(
  async ({ request }) => {
    const q = parseManageQuery(request, querySchema);
    const result = await listAdminUsersPage(
      {
        q: q.q,
        status: q.status,
        lifecycle: q.lifecycle,
        credential: q.credential,
        sort: q.sort,
        perPage: q.size !== 20 ? q.size : undefined,
      },
      q.page ?? 1,
    );
    return manageOk(result);
  },
  { endpoint: "users", permission: "admin.users" },
);
