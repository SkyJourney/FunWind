import { redirect } from "next/navigation";
import { checkPermission, getModeratedForumIds } from "@/lib/authz/service";
import { getCurrentSubject } from "@/lib/authz/subject";
import { requireAdmin } from "@/lib/authz/require-admin";

export const dynamic = "force-dynamic";

/**
 * 后台首页跳转（M9.5 站长反馈：入口默认进看板）：按权限派生落点——
 * 站点权限（admin.logs 是看板菜单的门槛）→ 看板；纯版主 → 内容审核队列；其余 → 角色与授权。
 */
export default async function AdminIndex() {
  await requireAdmin();
  const subject = await getCurrentSubject();
  const [canLogs, moderated] = await Promise.all([
    checkPermission(subject, "admin.logs"),
    getModeratedForumIds(subject),
  ]);
  redirect(
    canLogs.allowed ? "/admin/dashboard" : moderated.length > 0 ? "/admin/review" : "/admin/authz",
  );
}
