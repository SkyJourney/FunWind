/**
 * 全站安全响应头（M5.6 S4）。纯函数，由 next.config.ts 的 headers() 调用，单测直接断言。
 *
 * CSP 目前只以 **Report-Only** 下发：先观察、收集违规，确认不会误伤正常页面再转为强制（见 docs/GATES.md 之外的 SECURITY 说明在 CHANGELOG）。
 * 策略刻意写成「现在就能强制执行而不破坏页面」的最小集合：
 *   · script-src 含 'unsafe-inline'：Next App Router 用内联脚本携带 RSC 载荷；改用 nonce 需要中间件逐请求生成，留作后续。
 *     所以这版 CSP 防的是外部脚本源、<object>/<base> 劫持、表单外投、被嵌入（点击劫持），不是内联脚本注入——后者仍靠 sanitize 白名单。
 *   · style-src 含 'unsafe-inline'：ProseMirror（Tiptap）编辑器与 Tailwind 的内联样式属性需要它。
 *   · img-src 放行 http/https：用户正文允许引用外站图片（lib/sanitize.ts 的 harden 只限协议，不限域名）。
 * /files/** 排除：该路由自带更严的 `default-src 'none'; sandbox`，不能被覆盖或叠加。
 */

export interface HeaderEnv {
  NODE_ENV?: string;
  APP_URL?: string;
}

type HeaderRule = { source: string; headers: { key: string; value: string }[] };

/** 除 /files 之外的全部路径 */
const NOT_FILES = "/((?!files/).*)";

export const CSP_REPORT_PATH = "/api/csp-report";

export function buildCsp(env: HeaderEnv): string {
  const dev = env.NODE_ENV === "development";
  return [
    "default-src 'self'",
    // 开发服务器的热更新（React Refresh）需要 eval；生产构建不需要
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: http:",
    "font-src 'self' data:",
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    "media-src 'self' https: http:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    `report-uri ${CSP_REPORT_PATH}`,
  ].join("; ");
}

export function buildSecurityHeaders(env: HeaderEnv): HeaderRule[] {
  const base = [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    // 点击劫持：frame-ancestors 只在 CSP 里，而 CSP 还是 Report-Only，所以旧式头单独强制
    { key: "X-Frame-Options", value: "DENY" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
    },
  ];
  // HSTS 只在站点本身是 https 且是生产构建时下发：http 下浏览器忽略它，开发环境下发则会污染 localhost 的 HSTS 缓存
  if (env.NODE_ENV === "production" && (env.APP_URL ?? "").startsWith("https://")) {
    base.push({ key: "Strict-Transport-Security", value: "max-age=15552000" });
  }
  return [
    { source: NOT_FILES, headers: base },
    {
      source: NOT_FILES,
      // 注意是 Report-Only：不会拦截任何东西。转强制前须先看违规报告（/api/csp-report 记日志）
      headers: [{ key: "Content-Security-Policy-Report-Only", value: buildCsp(env) }],
    },
  ];
}
