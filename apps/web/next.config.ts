import type { NextConfig } from "next";
import { config as loadEnv } from "dotenv";
import path from "node:path";
import { buildSecurityHeaders } from "./src/lib/security-headers";

// 环境单一来源：仓库根 .env（Next 只自动读应用目录，此处显式指向根）
loadEnv({ path: path.resolve(process.cwd(), "../../.env"), override: false });

const nextConfig: NextConfig = {
  // Next 16 安全默认会拦截"跨域"开发资源（HMR/运行时块）；显式放行本机与局域网访问主机
  // （站长实机经 192.168.50.253:3100 访问——不放行则客户端 JS 全被拦，页面可看不可点，M10.6d 实测教训）
  allowedDevOrigins: ["127.0.0.1", "localhost", "192.168.50.253"],
  // 不暴露框架标识
  poweredByHeader: false,
  // 全站安全响应头（含 CSP Report-Only），见 src/lib/security-headers.ts
  async headers() {
    return buildSecurityHeaders({ NODE_ENV: process.env.NODE_ENV, APP_URL: process.env.APP_URL });
  },
  // 非密钥常量内联进服务端 bundle（密钥类变量禁止走此通道，M5 另行处理）
  env: {
    STORAGE_DIR: process.env.STORAGE_DIR ?? "",
    APP_URL: process.env.APP_URL ?? "",
  },
};

export default nextConfig;
