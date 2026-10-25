import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { clientIpFrom } from "@/lib/net/client-ip";
import type { AdminActor } from "./admin";
import { checkPermission } from "./service";
import { loadSubject } from "./subject";

/**
 * 后台入口的统一门禁（审查 P2-15，纵深防御）。
 *
 * 为什么不能只靠 layout：Next 的局部渲染 / 客户端导航可以只请求叶子页面，已持有的 layout 不再重新渲染，
 * 文档明确建议「鉴权靠近数据，不要只放在 layout」。所以 `/admin/**` 的**每个页面**和**每个 Server Action**
 * 都要自己调用本函数，layout 里的那一次只负责体验（未登录跳登录页）。
 *
 * 约定（admin-entry-guard.test.ts 静态守护）：入口函数里的**第一个 await 必须是 requireAdmin(...)**，
 * 先于读取 params / searchParams 与任何取数。
 *
 * 语义：始终先要求 `site.admin`（后台总开关），再按需叠加更细的权限点；未登录 → 跳登录页；
 * 缺任一权限 → 404（硬约定 7：越权不暴露后台存在）。返回的 AdminActor 供写操作记审计。
 */
export type AdminPermission = "site.admin" | "admin.roles" | "admin.points" | "admin.badges";

export async function requireAdmin(...extra: AdminPermission[]): Promise<AdminActor> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const subject = await loadSubject(user.id);
  for (const perm of new Set<AdminPermission>(["site.admin", ...extra])) {
    if (!(await checkPermission(subject, perm)).allowed) notFound();
  }
  return { userId: user.id, ip: clientIpFrom(await headers()) };
}
