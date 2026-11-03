import { decorFs } from "@/lib/brand/decor-pool-fs";
import { serveBrandImage } from "@/lib/brand/brand-pool-fs";

/**
 * 主题装饰素材公开输出（M11.1 Step 4）：/brand/decor?file=<poolFile>
 * 主题包的图片底纹/装饰图经此路由加载（站内资源，不外链）。
 * 不在池内 → 404（主题回退到纯色/渐变，不出现破图）。
 */
export async function GET(req: Request): Promise<Response> {
  return serveBrandImage(req, decorFs);
}
