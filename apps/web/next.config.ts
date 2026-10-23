import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next 16 安全默认会拦截"跨域"开发资源（HMR/运行时块）；本机以 127.0.0.1 访问，需显式放行
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
