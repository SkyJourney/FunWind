import { NextResponse } from "next/server";

/**
 * 开发专用入口的统一守卫（/api/dev/*、/design）。
 * 生产构建中这些入口一律表现为 404。判断集中在这一处，并由 dev-only-guard.test.ts 保证
 * 每个开发路由的每个处理器都调用它——以后新增开发路由漏掉守卫，测试会红。
 */

export function isDevEnv(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV !== "production";
}

/** 路由处理器开头调用：非开发环境返回 404 响应，开发环境返回 null（继续处理） */
export function devOnlyResponse(): NextResponse | null {
  return isDevEnv() ? null : NextResponse.json({ error: "not found" }, { status: 404 });
}
