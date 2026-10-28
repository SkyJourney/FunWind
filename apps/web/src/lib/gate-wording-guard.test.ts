/**
 * 用户可见文案守卫（M10.8 Step 6）：界面上这类内容一律叫「锁定内容」，「门控」只保留为内部 / 文档术语。
 * 存储语法 `:::gate{}`、标识符、注释、测试与迁移报告不受影响；这里只扫**会进入界面的源码字符串**：
 * 应用代码、packages/content 的校验提示、权限点词汇表的说明文字。
 * 剥掉注释后再扫——注释里写「门控」是允许的。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|int\.test)\.(ts|tsx)$/.test(name))
      out.push(full);
  }
  return out;
}

/**
 * 源码里会进入界面的文本：字符串 / 模板字面量与 JSX 文本。用 TypeScript 解析器取节点，
 * 注释天然不在其中（手写扫描器会被正则字面量里的引号带偏，所以不用）。
 */
export function userVisibleTexts(file: string, src: string): { line: number; text: string }[] {
  const sf = ts.createSourceFile(
    file,
    src,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: { line: number; text: string }[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      out.push({
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        text: node.getText(sf),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const SCAN: string[] = [
  ...walk(join(ROOT, "apps/web/src")),
  // content 包：校验提示会显示在编辑器里；syntax-contract.ts 是契约用例数据，不是界面文案
  ...walk(join(ROOT, "packages/content/src")).filter((f) => !f.endsWith("syntax-contract.ts")),
  join(ROOT, "packages/db/src/authz-vocab.ts"),
];

describe("用户可见文案：不出现「门控」", () => {
  it("扫描范围非空（防止路径写错导致守卫形同虚设）", () => {
    expect(SCAN.length).toBeGreaterThan(100);
  });

  it("提取器自检：字符串与 JSX 文本被取到，注释与标识符不算", () => {
    const src =
      'const a = "门控"; // 门控\n/* 门控 */ const b = `x${1}门控`; const c = <p>门控</p>;\nconst 门控x = /"门控/;';
    const hits = userVisibleTexts("x.tsx", src).filter((t) => t.text.includes("门控"));
    // "门控"、模板字面量、JSX 文本各一处；注释、标识符、正则字面量不算
    expect(hits).toHaveLength(3);
  });

  it("应用代码 / content 校验提示 / 权限点说明里没有「门控」字样", () => {
    const hits = SCAN.flatMap((f) =>
      userVisibleTexts(f, readFileSync(f, "utf8"))
        .filter((t) => t.text.includes("门控"))
        .map((t) => `${f.replace(ROOT + "/", "")}:${t.line}  ${t.text.trim().slice(0, 80)}`),
    );
    expect(hits).toEqual([]);
  });
});
