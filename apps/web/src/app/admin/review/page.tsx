import { permanentRedirect } from "next/navigation";
import { requireModerator } from "@/lib/authz/require-admin";

export const dynamic = "force-dynamic";

/**
 * M19：「内容审核」页并入「内容管理」后保留旧路由的永久跳转（书签/旧链接兼容）。
 * 入口鉴权仍是第一个动作（admin-entry-guard 约定）：版主放行后跳待审队列；
 * 会员 404、游客回登录页——与合并前的门禁语义一致。
 */
export default async function ReviewRedirectPage() {
  await requireModerator();
  permanentRedirect("/admin/contents?state=pending");
}
