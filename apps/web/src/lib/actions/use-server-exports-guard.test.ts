// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 守卫：`"use server"` 文件里的每个运行时导出都必须是 `export const X = defineAction(...)`（M6.1）。
 *
 * 为什么：defineAction 收口了「求值模块注册表 / 鉴权 / 频控 / 输入校验 / 控制流重新抛出」。手写一个
 * `export async function fooAction(formData)` 会绕开这一切，漏掉其中任何一环都是一个洞（M5.6 之前真发生过）。
 * Server Action 的每个导出都是公开可调用的 HTTP 入口，所以这里不留例外。
 *
 * 允许：`export type` / `export interface`（编译期擦除，不是入口）。
 * 局限：纯文本分析，只认行首的 `export`；`export { a } from` 之类的转发导出也一律视为违规（看不出它是不是 defineAction）。
 */

const SRC = join(__dirname, "../..");

/** 返回违规的导出声明（每条为该行文本）；非 "use server" 文件返回空数组 */
export function nonDefineActionExports(src: string): string[] {
  if (!/^\s*["']use server["']/.test(src)) return [];
  const text = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const bad: string[] = [];
  for (const m of text.matchAll(/^\s*export\s+([^\n]*)/gm)) {
    const decl = m[1]!;
    if (/^(type|interface)\b/.test(decl)) continue;
    if (/^const\s+[\w$]+\s*=\s*defineAction\s*\(/.test(decl)) continue;
    bad.push(`export ${decl.trim()}`);
  }
  return bad;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

describe('"use server" 文件只导出 defineAction', () => {
  const files = walk(SRC)
    .map((p) => ({ rel: relative(SRC, p).split(sep).join("/"), src: readFileSync(p, "utf8") }))
    .filter((f) => !/\.test\.tsx?$/.test(f.rel) && /^\s*["']use server["']/.test(f.src));

  it("守卫没有空转：能发现全部 Server Action 文件", () => {
    expect(files.map((f) => f.rel).sort()).toEqual(
      expect.arrayContaining([
        "app/actions/auth.ts",
        "app/actions/gates.ts",
        "app/admin/actions.ts",
      ]),
    );
  });

  it("真实仓库里没有手写（绕开骨架）的 Server Action 导出", () => {
    const offenders = files.flatMap((f) =>
      nonDefineActionExports(f.src).map((d) => `${f.rel}: ${d}`),
    );
    expect(offenders).toEqual([]);
  });
});

describe("nonDefineActionExports 自身（合成样例）", () => {
  const head = '"use server";\nimport { defineAction } from "@/lib/actions/define-action";\n';

  it("defineAction 与类型导出合规", () => {
    expect(
      nonDefineActionExports(
        head +
          'export const a = defineAction({ name: "a", auth: "guest", async run() {} });\nexport type T = string;\nexport interface I {}',
      ),
    ).toEqual([]);
  });

  it("手写 async function / 箭头函数 / default / 转发导出 / 普通常量，全部违规", () => {
    for (const bad of [
      "export async function fooAction(f: FormData) {}",
      "export const fooAction = async (f: FormData) => {};",
      "export default async function () {}",
      'export { x } from "./y";',
      "export const LIMIT = 5;",
      "export function sync() {}",
    ]) {
      expect(nonDefineActionExports(head + bad), bad).toEqual([bad]);
    }
  });

  it("注释里的 export 不算；不是 use server 的文件不检查", () => {
    expect(nonDefineActionExports(head + "// export async function x() {}")).toEqual([]);
    expect(nonDefineActionExports("export async function x() {}")).toEqual([]);
  });
});
