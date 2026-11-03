import { redirect } from "next/navigation";
import { checkPermission, getModeratedForumIds } from "@/lib/authz/service";
import { getCurrentSubject } from "@/lib/authz/subject";
import { requireModerator } from "@/lib/authz/require-admin";

export const dynamic = "force-dynamic";

/**
 * 后台首页跳转（M9.5 站长反馈：入口默认进看板）：按权限派生落点——
 * 站点权限（admin.logs 是看板菜单的门槛）→ 看板；纯版主 → 内容审核队列；其余 → 角色与授权。
 * 总门与布局相同：站点管理员或任一版块版主，避免可见入口与实际可达范围分离。
 */
export default async function AdminIndex() {
  await requireModerator();
  const subject = await getCurrentSubject();
  const [canLogs, moderated] = await Promise.all([
    checkPermission(subject, "admin.logs"),
    getModeratedForumIds(subject),
  ]);
  redirect(
    canLogs.allowed ? "/admin/dashboard" : moderated.length > 0 ? "/admin/review" : "/admin/authz",
  );
}
