import type { NextConfig } from "next";
import { config as loadEnv } from "dotenv";
import path from "node:path";
import { buildSecurityHeaders } from "./src/lib/security-headers";

// 环境单一来源：仓库根 .env（Next 只自动读应用目录，此处显式指向根）
loadEnv({ path: path.resolve(process.cwd(), "../../.env"), override: false });

const nextConfig: NextConfig = {
  // 构建/开发产物目录可由环境变量隔离：E2E 用独立的 distDir，才能与 dev 服务（3100）同时运行——
  // Next 16 在同一 distDir 下只允许一个 next dev（目录锁），build 与 dev 共用 .next 也会互相踩踏
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Next 16 安全默认会拦截"跨域"开发资源（HMR/运行时块）；显式放行本机与局域网访问主机
  // （站长实机经 192.168.50.253:3100 访问——不放行则客户端 JS 全被拦，页面可看不可点，M10.6d 实测教训）
  allowedDevOrigins: ["127.0.0.1", "localhost", "192.168.50.253"],
  // 不暴露框架标识
  poweredByHeader: false,
  // 全站安全响应头（含 CSP Report-Only），见 src/lib/security-headers.ts。
  // SW 脚本必须每次重新校验更新，不能被浏览器长缓存；注册范围固定根路径。
  async headers() {
    return [
      ...buildSecurityHeaders({ NODE_ENV: process.env.NODE_ENV, APP_URL: process.env.APP_URL }),
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
  // 不再用 next.config 的 env 字段内联 STORAGE_DIR / APP_URL（M13 Step 1）：
  // env 字段是构建期内联——生产镜像 build 时拿不到部署值，固化占位会让运行时配置失效（违背 env 外置形态）。
  // 服务端代码（getStorageDir / lib/site 的 APP_URL / isSecureSite）都是运行时读进程 env：
  // 值由顶层 loadEnv（本机 .env）或部署环境注入（docker env_file / -e），两条路都走进程 env，行为一致。
};

export default nextConfig;
