// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 守卫：附件表（attachments）只能经 lib/gates/attachments.ts 读写（硬约定 3d，docs/ATTACHMENT-GATES.md §6）。
 * 门控附件与隐藏正文同权；任何其他运行时文件一旦自行从 `@funwind/db` 引入 `attachments` 表，
 * 就可能绕过门控把文件名 / 存储键 / 文件本身交给无权的观众。
 * 测试文件造夹具可以直接用表；迁移与种子在 packages/db、migration/，不在本目录树内。
 */
const SRC = join(__dirname, "../..");
const ALLOWED = new Set(["lib/gates/attachments.ts"].map((p) => p.split("/").join(sep)));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

/** 从 "@funwind/db" 的具名导入里引入了 attachments（可跨多行） */
const IMPORTS_ATTACHMENTS =
  /import\s*(?:type\s*)?\{[^}]*\battachments\b[^}]*\}\s*from\s*["']@funwind\/db["']/;

describe("附件表唯一读写点", () => {
  it("除 lib/gates/attachments.ts 外，运行时代码不得从 @funwind/db 引入 attachments 表", () => {
    const offenders = walk(SRC)
      .map((p) => relative(SRC, p))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => !/\.test\.tsx?$/.test(rel))
      .filter((rel) => IMPORTS_ATTACHMENTS.test(readFileSync(join(SRC, rel), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("守卫自身有效：attachments.ts 确实引入了 attachments 表；正则能识别多行导入", () => {
    expect(readFileSync(join(SRC, "lib/gates/attachments.ts"), "utf8")).toMatch(
      IMPORTS_ATTACHMENTS,
    );
    expect(
      IMPORTS_ATTACHMENTS.test('import {\n  files,\n  attachments,\n} from "@funwind/db";'),
    ).toBe(true);
    expect(IMPORTS_ATTACHMENTS.test('import { files } from "@funwind/db";')).toBe(false);
    // 页面里叫 attachments 的局部变量不算
    expect(IMPORTS_ATTACHMENTS.test("const [attachments, parents] = await Promise.all([]);")).toBe(
      false,
    );
  });
});
