import { NextResponse, type NextRequest } from "next/server";

/**
 * 全站中间件（M9.5 由 proxy.ts 更名 middleware.ts——Next 16 生产模式只识别 middleware.ts，
 * proxy.ts 在 dev 兼容、prod 下完全不加载，middleware-manifest 为空）。两件事：
 * ① 双轨强制换密快速门（docs/PASSWORD-DUAL-TRACK.md）：只读 cookie、不查库（edge 兼容；
 *    真源 = users.legacy_password_pending，登录动作发牌、换密动作销毁）。
 *    命中 → 除换密页外一律重定向强制换密页；页面自身仍做服务端 pending 复核
 *    （cookie 残留/过期会话不构成绕过或误困）。
 * ② 畸形 URL 门（CI 全量 E2E 迁移时暴露）：超长 UTF-8（%c0%ae 等）是非法编码序列，
 *    生产下 Next 解码异常冒泡成 500（dev 下 Next 层拒成 400）——攻击/畸形形态按约定一律 404。
 */
const MUST_CHANGE_COOKIE = "fw_must_change"; // 与 lib/auth/session.ts MUST_CHANGE_COOKIE 同值（edge 不引 server 模块）
const CHANGE_PATH = "/settings/password";

export function middleware(req: NextRequest) {
  // 畸形 URL 门：必须从 req.url 提取原始 pathname，不能读取 req.nextUrl——
  // Next 构造 nextUrl 时已解码，非法序列会提前抛 URIError（这就是生产 500 的来源）。
  // query 与合法编码值不参与路径安全判断，避免误伤搜索词/标签中的百分号。
  const rawPath = req.url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, "").split(/[?#]/, 1)[0] ?? "";
  if (rawPath.includes("%")) {
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(rawPath);
    } catch {
      return new Response("not found", { status: 404 });
    }
    const segments = decodedPath.split("/");
    // 点段/解码后的重复斜杠可改变路由分段语义，统一拒绝（含 %c0%ae / %c0%af）。
    if (segments.some((part) => part === "." || part === "..") || decodedPath.includes("//")) {
      return new Response("not found", { status: 404 });
    }
  }

  if (req.cookies.get(MUST_CHANGE_COOKIE)?.value !== "1") return NextResponse.next();
  if (req.nextUrl.pathname.startsWith(CHANGE_PATH) || req.nextUrl.pathname.startsWith("/login")) {
    return NextResponse.next();
  }
  const url = req.nextUrl.clone();
  url.pathname = CHANGE_PATH;
  url.search = "?force=1";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|brand/|logo/).*)"],
};
