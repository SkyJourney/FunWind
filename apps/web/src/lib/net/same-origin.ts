/**
 * 同源检查（Route Handler 用）。
 * 不能直接比较 request.url 的 origin：Next 按服务绑定的主机名构造 request.url（例如 localhost），
 * 与浏览器实际发送的 Origin（127.0.0.1 或真实域名）不一致，同源请求会被误拒。
 * 因此与 Server Action 的判定一致：期望的 Origin = 协议 + Host 头（协议优先取 X-Forwarded-Proto，反代后面必需）。
 * 跨站请求的 Host 是本站、Origin 是别的站点，仍然不相等，会被拒绝。
 * 不带 Origin 的请求（非浏览器）返回 true，沿用各路由既有的放行规则。
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  const url = new URL(request.url);
  const host = request.headers.get("host") ?? url.host;
  const proto = (request.headers.get("x-forwarded-proto") ?? url.protocol.replace(/:$/, ""))
    .split(",")[0]!
    .trim();
  return origin === `${proto}://${host}`;
}
