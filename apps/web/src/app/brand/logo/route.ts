import { readLogoBytes } from "@/lib/brand/logo-pool-fs";

/**
 * 品牌 LOGO 公开输出（M10.5 LOGO 池）：品牌位全端公开（每页必出、含游客），
 * 故独立于 /files 内容授权管线；`?file=` 可查看池内任意候选（同为品牌素材）；
 * 无当前项/不在池内 → 404（头部按 chrome 数据回退占位，不会出现破图）。
 */
export async function GET(req: Request): Promise<Response> {
  const file = new URL(req.url).searchParams.get("file") ?? undefined;
  const bytes = await readLogoBytes(file ?? undefined);
  if (!bytes) return new Response(null, { status: 404 });
  return new Response(bytes as unknown as BodyInit, {
    headers: {
      "content-type": "image/png",
      // 短缓存：切换 LOGO 后最多 5 分钟全局收敛（管理页保存另有 chrome 失效即时性）
      "cache-control": "public, max-age=300",
    },
  });
}
