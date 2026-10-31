import { heroFs } from "@/lib/brand/hero-pool-fs";
import { serveBrandImage } from "@/lib/brand/brand-pool-fs";

/**
 * 首页 Hero 横幅公开输出（M11 插槽 ⑤）：首页游客可见，独立于 /files 授权管线；
 * 无当前项 → 404（首页按 chrome.heroActive 不渲染，不会出现破图）。
 */
export async function GET(req: Request): Promise<Response> {
  return serveBrandImage(req, heroFs);
}
