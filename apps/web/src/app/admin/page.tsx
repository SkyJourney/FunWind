import { redirect } from "next/navigation";
import { checkPermission, getModeratedForumIds } from "@/lib/authz/service";
import { getCurrentSubject } from "@/lib/authz/subject";
import { requireAdmin } from "@/lib/authz/require-admin";

export const dynamic = "force-dynamic";

/**
 * 后台首页（M8 遗留的占位跳转）：按权限派生落点——
 * 版主（无任何 admin.* 站点权限）→ 内容审核队列；否则 → 审计中心（S8 交付前暂为角色页）。
 */
export default async function AdminIndex() {
  await requireAdmin();
  const subject = await getCurrentSubject();
  const [canLogs, moderated] = await Promise.all([
    checkPermission(subject, "admin.logs"),
    getModeratedForumIds(subject),
  ]);
  redirect(
    canLogs.allowed || moderated.length > 0
      ? canLogs.allowed
        ? "/admin/logs"
        : "/admin/review"
      : "/admin/authz",
  );
}
