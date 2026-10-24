// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 守卫：隐藏正文（post_gates.hidden_md）只能经 lib/gates/service.ts 读取（硬约定 3b）。
 * 任何其他源文件出现 hiddenMd / hidden_md 都会让这个测试变红——
 * 防止有人为了“方便”在搜索、RSS、预览、通知里直读隐藏内容。
 * 例外：lib/gates/write.ts（M6.1 门控写入器）要写这一列，所以在白名单里；它承诺只写不读，由下面第三条断言守住。
 */
const SRC = join(__dirname, "../..");
const ALLOWED = new Set(
  ["lib/gates/service.ts", "lib/gates/write.ts", "lib/gates/hidden-md-guard.test.ts"].map((p) =>
    p.split("/").join(sep),
  ),
);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

describe("隐藏正文唯一读取点", () => {
  it("除 lib/gates/service.ts 外，没有任何源文件引用 hiddenMd / hidden_md", () => {
    const offenders = walk(SRC)
      .map((p) => relative(SRC, p))
      .filter((rel) => !ALLOWED.has(rel))
      // 测试夹具里造数据、断言“不含隐藏文本”是合法的；运行时代码不行
      .filter((rel) => !/\.test\.tsx?$/.test(rel))
      .filter((rel) => /hiddenMd|hidden_md/.test(readFileSync(join(SRC, rel), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("写入器 write.ts 只写不读：不得有不带字段列表的 select()，也不得在 select({…}) 里取 hiddenMd", () => {
    const src = readFileSync(join(SRC, "lib/gates/write.ts"), "utf8").replace(
      /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
      "",
    );
    expect(src).toMatch(/hiddenMd/); // 守卫没有空转：它确实在写这一列
    expect(src).not.toMatch(/\.select\(\s*\)/);
    expect(src).not.toMatch(/\.selectDistinct\(\s*\)/);
    for (const m of src.matchAll(/\.select(?:Distinct)?\(\s*\{([^}]*)\}/g)) {
      expect(m[1], "select 字段列表").not.toMatch(/hiddenMd/);
    }
  });

  it("守卫自身有效：service.ts 确实引用了 hiddenMd（防止路径写错导致空转）", () => {
    expect(readFileSync(join(SRC, "lib/gates/service.ts"), "utf8")).toMatch(/hiddenMd/);
  });
});
