import { NextResponse, type NextRequest } from "next/server";

/**
 * 双轨强制换密快速门（docs/PASSWORD-DUAL-TRACK.md）：
 * 只读 cookie、不查库（edge 兼容；真源 = users.legacy_password_pending，
 * 登录动作发牌、换密动作销毁）。命中 → 除换密页外一律重定向强制换密页。
 * 页面自身仍做服务端 pending 复核（cookie 残留/过期会话不构成绕过或误困）。
 */
const MUST_CHANGE_COOKIE = "fw_must_change"; // 与 lib/auth/session.ts MUST_CHANGE_COOKIE 同值（edge 不引 server 模块）
const CHANGE_PATH = "/settings/password";

export function middleware(req: NextRequest) {
  if (req.cookies.get(MUST_CHANGE_COOKIE)?.value !== "1") return NextResponse.next();
  if (req.nextUrl.pathname.startsWith(CHANGE_PATH)) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = CHANGE_PATH;
  url.search = "?force=1";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|brand/|logo/|files/).*)"],
};
