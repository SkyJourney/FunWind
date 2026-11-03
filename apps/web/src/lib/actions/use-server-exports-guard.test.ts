// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

/**
 * 守卫：`"use server"` 文件里的每个运行时导出都必须是 `export const X = defineAction(...)`（M6.1）。
 *
 * 为什么：defineAction 收口了「求值模块注册表 / 鉴权 / 频控 / 输入校验 / 控制流重新抛出」。手写一个
 * `export async function fooAction(formData)` 会绕开这一切，漏掉其中任何一环都是一个洞（M5.6 之前真发生过）。
 * Server Action 的每个导出都是公开可调用的 HTTP 入口，所以这里不留例外。
 *
 * 允许：`export type` / `export interface`（编译期擦除，不是入口）。
 * AST 按模块指令序言识别 Action 文件，逐条检查导出声明及变量绑定；注释、换行与同行声明不会掩盖入口。
 * `export { a } from` 等运行时转发仍拒绝（无法在本文件确认它经过 defineAction），纯类型转发与空导出不计入口。
 */

const SRC = join(__dirname, "../..");

/** 只认模块指令序言；注释不影响指令，普通字符串和函数内指令不改变模块边界。 */
function hasUseServer(source: ts.SourceFile): boolean {
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    if (statement.expression.text === "use server") return true;
  }
  return false;
}

/** 括号与类型断言不改变初始化器的运行时来源。 */
function unwrapInitializer(node: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  )
    node = node.expression;
  return node;
}

/** 返回违规的运行时导出声明或单个变量绑定；非模块级 "use server" 文件返回空数组。 */
export function nonDefineActionExports(src: string): string[] {
  const source = ts.createSourceFile("action.ts", src, ts.ScriptTarget.Latest, true);
  if (!hasUseServer(source)) return [];
  const bad: string[] = [];
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (
        statement.isTypeOnly ||
        (clause &&
          ts.isNamedExports(clause) &&
          clause.elements.every((element) => element.isTypeOnly))
      )
        continue;
      bad.push(statement.getText(source));
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      bad.push(statement.getText(source));
      continue;
    }
    if (
      !ts.canHaveModifiers(statement) ||
      !ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    )
      continue;
    if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) continue;
    if (ts.isVariableStatement(statement)) {
      const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
      const kind = isConst
        ? "const"
        : statement.declarationList.flags & ts.NodeFlags.Let
          ? "let"
          : "var";
      for (const declaration of statement.declarationList.declarations) {
        const initializer = declaration.initializer && unwrapInitializer(declaration.initializer);
        if (
          isConst &&
          ts.isIdentifier(declaration.name) &&
          initializer &&
          ts.isCallExpression(initializer) &&
          ts.isIdentifier(unwrapInitializer(initializer.expression)) &&
          unwrapInitializer(initializer.expression).getText(source) === "defineAction"
        )
          continue;
        // 多变量声明逐绑定报告，不能让合规的第一个导出掩盖同一声明里的其他入口。
        const suffix =
          statement.declarationList.declarations.length === 1 &&
          statement.getText(source).endsWith(";")
            ? ";"
            : "";
        bad.push(`export ${kind} ${declaration.getText(source)}${suffix}`);
      }
      continue;
    }
    bad.push(statement.getText(source));
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
    .filter(
      (f) =>
        !/\.test\.tsx?$/.test(f.rel) &&
        hasUseServer(ts.createSourceFile(f.rel, f.src, ts.ScriptTarget.Latest, true)),
    );

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
  it.each(["// 文件说明\n", "/* 文件说明 */\n", "\uFEFF// 文件说明\n"])(
    "前置注释不掩盖 Server Action 导出：%s",
    (prefix) => {
      expect(
        nonDefineActionExports(`${prefix}"use server";\nexport async function unsafe() {}`),
      ).toEqual(["export async function unsafe() {}"]);
    },
  );

  it("同一声明的每个导出绑定独立校验，合规的首项不能为后项背书", () => {
    expect(
      nonDefineActionExports(`"use server";
        export const safe = defineAction({}), unsafe = async () => {}, other = 1;`),
    ).toEqual(["export const unsafe = async () => {}", "export const other = 1"]);
    expect(
      nonDefineActionExports(`"use server";
        export const unsafe = async () => {}, safe = defineAction({});`),
    ).toEqual(["export const unsafe = async () => {}"]);
  });

  it("同行导出仍逐个检查，不能藏在前一个合规声明后", () => {
    expect(
      nonDefineActionExports(
        '"use server"; export const safe = defineAction({}); export async function unsafe() {}',
      ),
    ).toEqual(["export async function unsafe() {}"]);
  });

  it("合法的多绑定、换行、类型参数和表达式包装不误报", () => {
    expect(
      nonDefineActionExports(`/* 文件说明 */
        "use strict";
        "use server";
        export const first = defineAction({}), second = defineAction({});
        export const third =
          (defineAction<Input>({}) satisfies Action);
        export const fourth = defineAction({}) as Action;
        export type T = string;
        export interface I {}
        export type { T } from './types';
        export { type I } from './types';
        export {};`),
    ).toEqual([]);
  });

  it("只认模块指令序言，不把后置字符串、注释与函数内指令当成模块 Action", () => {
    for (const source of [
      '// "use server";\nexport async function ordinary() {}',
      'const text = "use server"; export async function ordinary() {}',
      'import "./dependency"; "use server"; export async function ordinary() {}',
      'export async function ordinary() { "use server"; }',
    ]) {
      expect(nonDefineActionExports(source)).toEqual([]);
    }
  });

  it("拒绝可变导出、解构和其它运行时声明，不把类型导出当入口", () => {
    for (const declaration of [
      "export let action = defineAction({})",
      "export var action = defineAction({})",
      "export const { action } = defineAction({})",
      "export enum Mode { One }",
      "export namespace Actions { export const value = 1; }",
      "export { type Input, action } from './actions'",
    ]) {
      expect(nonDefineActionExports(`"use server";\n${declaration}`), declaration).toHaveLength(1);
    }
  });
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
