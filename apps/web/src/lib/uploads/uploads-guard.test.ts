// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 守卫：上传记录表（file_uploads）只能经 lib/uploads/store.ts 写入（M6.4，计划「对设计稿的修正」第 10 条）。
 * file_uploads 是配额计数与「谁上传过这个文件」归属判定的依据；任何其它地方随意插入 / 修改都会破坏配额与归属。
 * M6.4d 的写入侧校验（registerPostFiles）只需读归属，读取同样集中在本守卫允许的文件里（见 ALLOWED）。
 */
const SRC = join(__dirname, "../..");
const ALLOWED = new Set(
  ["lib/uploads/store.ts", "lib/gates/attachments.ts"].map((p) => p.split("/").join(sep)),
);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

/** 从 "@funwind/db" 的具名导入里引入了 fileUploads（可跨多行） */
const IMPORTS_FILE_UPLOADS =
  /import\s*(?:type\s*)?\{[^}]*\bfileUploads\b[^}]*\}\s*from\s*["']@funwind\/db["']/;

describe("上传记录表唯一写入点", () => {
  it("除允许清单外，运行时代码不得从 @funwind/db 引入 fileUploads 表", () => {
    const offenders = walk(SRC)
      .map((p) => relative(SRC, p))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => !/\.test\.tsx?$/.test(rel))
      .filter((rel) => IMPORTS_FILE_UPLOADS.test(readFileSync(join(SRC, rel), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("守卫自身有效：store.ts 确实引入了 fileUploads；正则能识别多行导入，且忽略局部变量", () => {
    expect(readFileSync(join(SRC, "lib/uploads/store.ts"), "utf8")).toMatch(IMPORTS_FILE_UPLOADS);
    expect(
      IMPORTS_FILE_UPLOADS.test('import {\n  files,\n  fileUploads,\n} from "@funwind/db";'),
    ).toBe(true);
    expect(IMPORTS_FILE_UPLOADS.test('import { files } from "@funwind/db";')).toBe(false);
    expect(IMPORTS_FILE_UPLOADS.test("const [fileUploads, x] = [1, 2];")).toBe(false);
  });
});
