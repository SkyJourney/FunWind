// @vitest-environment node
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 安装向导入口守卫（M12 D2，仿 dev-only-guard）：
 * /install 的页面与全部 Server Action 都必须调用 requireNotInstalled()——
 * 漏挂任何一个入口，已安装站点就会暴露重装面（真实漏洞）。
 * 静态文本扫描按「源文件字面量」判定（守卫按文本匹配，注释也会命中——CLAUDE.md 已知坑）。
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const pageSrc = () => readFileSync(join(HERE, "page.tsx"), "utf8");
const actionsSrc = () => readFileSync(join(HERE, "actions.ts"), "utf8");

/** actions.ts 中 defineAction 的数量（按 name 字面量计） */
const exportedActions = () =>
  [...actionsSrc().matchAll(/name: "install\.[a-z]+"/g)].map((m) => m[0]);

describe("install 入口守卫（静态扫描，M12 D2）", () => {
  it("page.tsx 的第一个 await 是 requireNotInstalled（404 入口纪律，仿 admin-entry）", () => {
    const src = pageSrc();
    expect(src).toContain("await requireNotInstalled()");
    const firstAwait = src.indexOf("await ");
    expect(src.slice(firstAwait, firstAwait + 30)).toContain("requireNotInstalled()");
  });

  it("每个 Server Action 的 run 块都以 requireNotInstalled 开头且恰好一次（按块断言，防此漏彼挂）", () => {
    const actions = actionsSrc();
    // 按 "async run" 切块，块边界到下一个 Action 名或文件尾
    const blocks = actions.split(/name: "install\.[a-z]+",/).slice(1);
    expect(blocks.length).toBe(exportedActions().length);
    for (const block of blocks) {
      const body = block.split("async run")[1] ?? "";
      expect(body).toBeTruthy();
      const calls = [...body.matchAll(/await requireNotInstalled\(\)/g)].length;
      expect(calls).toBe(1);
      // 位于 run 体开头（首个语句就是守卫；body 以 "(_ctx…) {\n    await …" 开头）
      expect(body.slice(0, 80).includes("await requireNotInstalled()")).toBe(true);
    }
  });

  it("三个 Action 的名字符合 install.* 命名（database / site / admin）", () => {
    expect(exportedActions()).toEqual([
      'name: "install.database"',
      'name: "install.site"',
      'name: "install.admin"',
    ]);
  });
});
