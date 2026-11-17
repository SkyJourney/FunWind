import "@/modules";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/authz/require-admin";
import { isSameOrigin } from "@/lib/net/same-origin";
import { searchUsers } from "@/lib/authz/admin-user-views";

export const dynamic = "force-dynamic";

/**
 * 管理端用户搜索（M19 D4，UserPicker 输入即搜）：GET ?q=<用户名片段>。
 * 门口链：同源 → 会话+requireAdmin("admin.users")（JSON 语义，缺权限 404 不暴露存在性）→ 服务层。
 * 返回前 10 条「用户名 (uid)」候选；空 q 返回空数组（避免全库扫给 datalist 塞垃圾）。
 */
export async function GET(request: Request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  await requireAdmin("admin.users");
  const q = new URL(request.url).searchParams.get("q") ?? "";
  const hits = await searchUsers(q);
  return NextResponse.json(
    {
      items: hits.slice(0, 10).map((u) => ({
        id: u.id,
        username: u.username,
        label: `${u.username} (uid ${u.id})`,
      })),
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}
