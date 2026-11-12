import "server-only";

import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Service Worker 版本号（M16.1 Step 3）：取 Next 自己的 BUILD_ID。
 *
 * 为什么需要它：浏览器只在 **SW 脚本字节变化**时才更新 SW。sw.js 是 public 静态文件，
 * 部署后内容不变 —— 若只改了 offline.html 或缓存策略常量，浏览器不会重装，离线壳会一直用旧的。
 * 把版本号挂在注册 URL 上（`/sw.js?v=<BUILD_ID>`），每次部署脚本 URL 都不同，浏览器必然走一次
 * 安装流程，离线壳随之刷新。
 *
 * 为什么不走 next.config 的 env 内联：M13 Step 1 已明确弃用该字段（构建期内联会让生产镜像
 * 固化占位值）。BUILD_ID 由 Next 在构建时写入 distDir，运行时读文件即可，与部署环境无关。
 * 读一次缓存住；读不到（dev / 异常）回落 "dev"，不影响注册本身。
 */
let cached: string | null = null;

export function swVersion(): string {
  if (cached !== null) return cached;
  try {
    const distDir = process.env.NEXT_DIST_DIR || ".next";
    cached = readFileSync(path.join(process.cwd(), distDir, "BUILD_ID"), "utf8").trim() || "dev";
  } catch {
    cached = "dev";
  }
  return cached;
}
