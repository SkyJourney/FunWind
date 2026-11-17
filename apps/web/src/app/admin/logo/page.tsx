import { permanentRedirect } from "next/navigation";
import { requireAdmin } from "@/lib/authz/require-admin";

export const dynamic = "force-dynamic";

/**
 * M19 Q2：LOGO 池并入「品牌素材」单页（/admin/brand?kind=logo）后保留旧路由的永久跳转。
 * 入口鉴权仍是第一个动作（admin-entry-guard 约定）：非 site.admin 404，语义与合并前一致。
 */
export default async function LogoRedirectPage() {
  await requireAdmin("site.admin");
  permanentRedirect("/admin/brand?kind=logo");
}
