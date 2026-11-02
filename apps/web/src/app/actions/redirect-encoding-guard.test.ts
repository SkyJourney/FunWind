// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * G-01：扫描全部「use server」文件的真实跳转调用，防止未编码文案进入响应头。
 * 用语法树区分注释、字符串与调用，检查解码后的字面量（含 Unicode 转义与 emoji）。
 * error/err 动态值须编码；服务结果的 .code 属机器码，由页面码表解释。
 * 此守卫不推导任意函数的返回值，运行时错误路径仍由 E2E 兜底。
 */
const SRC = join(__dirname, "../..");
const UNSAFE = /[^\x00-\x7f]|[\r\n]/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

function parse(src: string): ts.SourceFile {
  return ts.createSourceFile("action.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function isServerActionFile(src: string): boolean {
  const first = parse(src).statements[0];
  return (
    !!first &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === "use server"
  );
}

function importedNames(source: ts.SourceFile, module: string, exported: string[]): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== module
    )
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const entry of bindings.elements) {
      if (exported.includes(entry.propertyName?.text ?? entry.name.text))
        names.add(entry.name.text);
    }
  }
  return names;
}

export function redirectProblems(src: string): string[] {
  const source = parse(src);
  const redirects = importedNames(source, "next/navigation", ["redirect", "permanentRedirect"]);
  const hops = importedNames(source, "@/lib/actions/hop", ["errorHop", "redirectWithError"]);
  const problems: string[] = [];

  function isEncoded(expr: ts.Expression): boolean {
    return (
      ts.isCallExpression(expr) &&
      ts.isIdentifier(expr.expression) &&
      (expr.expression.text === "encodeURIComponent" || hops.has(expr.expression.text))
    );
  }

  function check(expr: ts.Expression): string | null {
    if (ts.isStringLiteralLike(expr)) {
      return UNSAFE.test(expr.text) ? "未编码的非 ASCII 文案或换行" : null;
    }
    if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr))
      return check(expr.expression);
    if (ts.isConditionalExpression(expr)) return check(expr.whenTrue) ?? check(expr.whenFalse);
    if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return check(expr.left) ?? check(expr.right);
    }
    if (ts.isTemplateExpression(expr)) {
      const parts = [expr.head.text, ...expr.templateSpans.map((span) => span.literal.text)];
      if (parts.some((part) => UNSAFE.test(part))) return "未编码的非 ASCII 文案或换行";
      for (const [i, span] of expr.templateSpans.entries()) {
        const value = span.expression;
        const machineCode = ts.isPropertyAccessExpression(value) && value.name.text === "code";
        if (/[?&](?:error|err)=$/.test(parts[i]!) && !machineCode && !isEncoded(value)) {
          return "错误参数携带未编码动态值";
        }
        const problem = check(value);
        if (problem) return problem;
      }
    }
    if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
      if (expr.expression.text === "encodeURIComponent") return null;
      if (hops.has(expr.expression.text)) {
        // 共享工具只编码提示值，路径本身仍必须安全。
        return expr.arguments[0] ? check(expr.arguments[0]) : "跳转工具缺少路径";
      }
    }
    return null;
  }

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (redirects.has(name) || hops.has(name)) {
        const arg = node.arguments[0];
        const problem = arg ? check(arg) : "跳转缺少参数";
        if (problem) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          problems.push(`${line}: ${problem} → ${node.getText(source).slice(0, 100)}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return problems;
}

const IMPORT = 'import { redirect } from "next/navigation";\n';

describe("跳转参数编码守卫（G-01）", () => {
  const files = walk(join(SRC, "app"))
    .filter((path) => !/\.test\.tsx?$/.test(path))
    .map((path) => ({ path, src: readFileSync(path, "utf8") }))
    .filter(({ src }) => isServerActionFile(src));

  it("覆盖全局 Action、就地 Action 与主题预览 Action，不依赖文件名", () => {
    const names = files.map(({ path }) => relative(SRC, path));
    expect(names).toEqual(
      expect.arrayContaining([
        "app/actions/auth.ts",
        "app/actions/posts.ts",
        "app/closure/actions.ts",
        "app/appeal/actions.ts",
        "app/settings/delete-account/actions.ts",
        "app/theme-preview-actions.ts",
      ]),
    );
    expect(names.length).toBeGreaterThanOrEqual(30);
  });

  it("所有真实 Action 的跳转参数符合编码约定", () => {
    const offenders = files.flatMap(({ path, src }) =>
      redirectProblems(src).map((problem) => `${relative(SRC, path)}:${problem}`),
    );
    expect(offenders).toEqual([]);
  });
});

describe("redirectProblems 自身", () => {
  it("中文、emoji、Unicode 转义与拼接字符串都不能原样进响应头", () => {
    for (const expr of [
      '"/x?error=错误"',
      '"/x?error=😀"',
      '"/x?error=\\u9519"',
      '"/x?error=" + "错误"',
    ]) {
      expect(redirectProblems(IMPORT + `redirect(${expr});`), expr).toHaveLength(1);
    }
  });

  it("只认可导入的跳转与工具，支持别名，不把注释当代码", () => {
    expect(
      redirectProblems('import { redirect as go } from "next/navigation"; go("/x?error=错误");'),
    ).toHaveLength(1);
    expect(redirectProblems(IMPORT + '// redirect("/x?error=错误");')).toEqual([]);
    const hop = 'import { errorHop as hop } from "@/lib/actions/hop";\n';
    expect(redirectProblems(IMPORT + hop + 'redirect(hop("/x", "错误"));')).toEqual([]);
    expect(redirectProblems(IMPORT + hop + 'redirect(hop("/错误", "提示"));')).not.toEqual([]);
  });

  it("人话动态错误值须编码，机器码 .code 和普通 id 不误报", () => {
    expect(redirectProblems(IMPORT + "redirect(`/x?error=${e.message}`);")).toHaveLength(1);
    expect(redirectProblems(IMPORT + "redirect(`/x?err=${e.message}`);")).toHaveLength(1);
    expect(
      redirectProblems(IMPORT + "redirect(`/x?error=${encodeURIComponent(e.message)}`);"),
    ).toEqual([]);
    expect(redirectProblems(IMPORT + "redirect(`/x?error=${r.code}`);")).toEqual([]);
    expect(redirectProblems(IMPORT + "redirect(`/x/${id}`);")).toEqual([]);
  });
});
