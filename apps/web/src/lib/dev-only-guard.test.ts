// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 守卫：开发专用入口必须逐个处理器接入 dev-only 守卫。
 *   · app/api/dev/** 下每个 route.ts：每个导出的 HTTP 处理器函数都要调用 devOnlyResponse()；
 *   · app/design/** 下的 page.tsx：必须调用 isDevEnv() 并在非开发环境 notFound()。
 * 数量对不上（新增了处理器却漏了守卫）或出现新的未守卫文件，测试即红。
 */
const APP = join(__dirname, "../app");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const HANDLER = /export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g;

describe("开发专用入口的守卫", () => {
  const routes = walk(join(APP, "api/dev")).filter((p) => /route\.ts$/.test(p));

  it("守卫自身有效：确实扫到了 dev 路由与处理器（防止路径写错导致空转）", () => {
    expect(routes.length).toBeGreaterThanOrEqual(3);
    const handlers = routes.flatMap((p) => [...readFileSync(p, "utf8").matchAll(HANDLER)]);
    expect(handlers.length).toBeGreaterThanOrEqual(4);
  });

  it("app/api/dev 下每个处理器都调用 devOnlyResponse()", () => {
    for (const p of routes) {
      const src = readFileSync(p, "utf8");
      const handlers = [...src.matchAll(HANDLER)].length;
      const guards = [...src.matchAll(/devOnlyResponse\(\)/g)].length;
      expect(guards, `${relative(APP, p)}：${handlers} 个处理器，${guards} 处守卫`).toBe(handlers);
      expect(src, relative(APP, p)).toMatch(/from\s+"@\/lib\/dev-only"/);
    }
  });

  it("app/design 下的页面在非开发环境 notFound()", () => {
    const pages = walk(join(APP, "design")).filter((p) => /page\.tsx$/.test(p));
    expect(pages.length).toBeGreaterThanOrEqual(1);
    for (const p of pages) {
      const src = readFileSync(p, "utf8");
      expect(src, relative(APP, p)).toMatch(/isDevEnv\(\)/);
      expect(src, relative(APP, p)).toMatch(/notFound\(\)/);
    }
  });
});
