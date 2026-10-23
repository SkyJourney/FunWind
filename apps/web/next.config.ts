import type { NextConfig } from "next";
import { config as loadEnv } from "dotenv";
import path from "node:path";

// 环境单一来源：仓库根 .env（Next 只自动读应用目录，此处显式指向根）
loadEnv({ path: path.resolve(process.cwd(), "../../.env"), override: false });

const nextConfig: NextConfig = {
  // Next 16 安全默认会拦截"跨域"开发资源（HMR/运行时块）；本机以 127.0.0.1 访问，需显式放行
  allowedDevOrigins: ["127.0.0.1"],
  // 非密钥路径常量内联进服务端 bundle（密钥类变量禁止走此通道，M5 另行处理）
  env: {
    ATTACHMENT_DIR: process.env.ATTACHMENT_DIR ?? "",
    EMOTION_DIR: process.env.EMOTION_DIR ?? "",
  },
};

export default nextConfig;
