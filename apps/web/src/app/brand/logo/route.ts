import { logoFs } from "@/lib/brand/logo-pool-fs";
import { serveBrandImage } from "@/lib/brand/brand-pool-fs";

/**
 * 品牌 LOGO 公开输出（M10.5 LOGO 池）：品牌位全端公开（每页必出、含游客），
 * 故独立于 /files 内容授权管线；输出与缓存口径见 serveBrandImage（与 /brand/hero 共用）。
 */
export async function GET(req: Request): Promise<Response> {
  return serveBrandImage(req, logoFs);
}
