import ts from "typescript";
import { resolveModule, type Sources } from "./source-graph";

export interface ValueOrigin {
  module: string;
  name: string;
}

/** 扫描业务源文件；测试目录、夹具和声明文件不参与生产入口约束。 */
export function productionSources(sources: Sources): Sources {
  return Object.fromEntries(
    Object.entries(sources).filter(
      ([path]) =>
        !/(^|\/)(?:test|tests|__tests__)\//.test(path) &&
        !/\.(?:test|spec|d)\.[cm]?[jt]sx?$/.test(path),
    ),
  );
}

export function unwrap(node: ts.Node): ts.Node {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAwaitExpression(node) ||
    ts.isSatisfiesExpression(node)
  )
    node = node.expression;
  return node;
}

export function memberName(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
    return node.argumentExpression.text;
  return undefined;
}

/** 只建立内存语法与词法绑定，不加载业务模块、不解析真实数据库或执行其初始化。 */
export function sourceSymbols(input: Sources) {
  const sources = productionSources(input);
  const files = new Map(
    Object.entries(sources).map(([path, text]) => [
      path,
      ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true),
    ]),
  );
  const options: ts.CompilerOptions = {
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.ESNext,
  };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (path) => files.get(path.replace(/^\//, ""));
  host.getCurrentDirectory = () => "/";
  const checker = ts.createProgram([...files.keys()], options, host).getTypeChecker();
  const declaration = (node: ts.Node) => checker.getSymbolAtLocation(node)?.declarations?.[0];
  const target = (from: ts.Node, specifier: string) =>
    resolveModule(from.getSourceFile().fileName, specifier, sources) ?? specifier;
  const exported = (node: ts.Node) =>
    ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);

  function exportsOf(module: string, seen = new Set<string>()): string[] {
    if (seen.has(module)) return [];
    seen.add(module);
    const names = new Set<string>();
    for (const statement of files.get(module)?.statements ?? []) {
      if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const entry of statement.exportClause.elements)
            if (!entry.isTypeOnly) names.add(entry.name.text);
        } else if (statement.exportClause) names.add(statement.exportClause.name.text);
        else if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
          for (const name of exportsOf(target(statement, statement.moduleSpecifier.text), seen))
            names.add(name);
        }
      } else if (ts.isExportAssignment(statement)) names.add("default");
      else if (exported(statement)) {
        if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
          if (statement.name) names.add(statement.name.text);
        } else if (ts.isVariableStatement(statement)) {
          for (const entry of statement.declarationList.declarations)
            if (ts.isIdentifier(entry.name)) names.add(entry.name.text);
        }
      }
    }
    return [...names];
  }

  function exportedOrigin(module: string, name: string, seen: Set<ts.Node>): ValueOrigin | null {
    const file = files.get(module);
    if (!file) return { module, name };
    for (const statement of file.statements) {
      if (seen.has(statement)) continue;
      const next = new Set(seen).add(statement);
      if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
        const destination =
          statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
            ? target(statement, statement.moduleSpecifier.text)
            : undefined;
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          const entry = statement.exportClause.elements.find(
            (entry) => !entry.isTypeOnly && entry.name.text === name,
          );
          if (entry) {
            if (destination)
              return exportedOrigin(destination, (entry.propertyName ?? entry.name).text, next);
            const symbol = checker.getExportSpecifierLocalTargetSymbol(entry);
            const local = symbol?.declarations?.[0];
            return local ? originOfDeclaration(local, next) : null;
          }
        } else if (statement.exportClause?.name.text === name && destination) {
          return { module: destination, name: "*" };
        } else if (!statement.exportClause && destination) {
          const result = exportedOrigin(destination, name, next);
          if (result) return result;
        }
      } else if (ts.isExportAssignment(statement) && name === "default") {
        return origin(statement.expression, next);
      } else if (exported(statement)) {
        if (
          (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
          statement.name?.text === name
        )
          return { module, name };
        if (ts.isVariableStatement(statement)) {
          const entry = statement.declarationList.declarations.find(
            (entry) => ts.isIdentifier(entry.name) && entry.name.text === name,
          );
          if (entry)
            return (entry.initializer && origin(entry.initializer, next)) || { module, name };
        }
      }
    }
    return null;
  }

  function member(value: ValueOrigin | null, name: string, seen: Set<ts.Node>) {
    if (!value) return null;
    if (value.name === "*") return exportedOrigin(value.module, name, seen);
    return { module: value.module, name: `${value.name}.${name}` };
  }

  function originOfDeclaration(node: ts.Declaration, seen: Set<ts.Node>): ValueOrigin | null {
    if (seen.has(node)) return null;
    const next = new Set(seen).add(node);
    if (ts.isImportSpecifier(node)) {
      const clause = node.parent.parent;
      const statement = clause.parent;
      if (node.isTypeOnly || clause.isTypeOnly || !ts.isStringLiteral(statement.moduleSpecifier))
        return null;
      return exportedOrigin(
        target(statement, statement.moduleSpecifier.text),
        (node.propertyName ?? node.name).text,
        next,
      );
    }
    if (ts.isImportEqualsDeclaration(node)) {
      if (
        node.isTypeOnly ||
        !ts.isExternalModuleReference(node.moduleReference) ||
        !node.moduleReference.expression ||
        !ts.isStringLiteralLike(node.moduleReference.expression)
      )
        return null;
      return { module: target(node, node.moduleReference.expression.text), name: "*" };
    }
    if (ts.isNamespaceImport(node) || ts.isImportClause(node)) {
      const clause = ts.isNamespaceImport(node) ? node.parent : node;
      const statement = clause.parent;
      if (clause.isTypeOnly || !ts.isStringLiteral(statement.moduleSpecifier)) return null;
      const modulePath = target(statement, statement.moduleSpecifier.text);
      return ts.isNamespaceImport(node)
        ? { module: modulePath, name: "*" }
        : exportedOrigin(modulePath, "default", next);
    }
    if (ts.isVariableDeclaration(node) && node.initializer) return origin(node.initializer, next);
    if (
      ts.isParameter(node) &&
      (ts.isArrowFunction(node.parent) || ts.isFunctionExpression(node.parent))
    ) {
      const call = node.parent.parent;
      if (
        ts.isCallExpression(call) &&
        ts.isPropertyAccessExpression(call.expression) &&
        call.expression.name.text === "then" &&
        call.arguments[0] === node.parent
      )
        return origin(call.expression.expression, next);
    }
    if (ts.isBindingElement(node)) {
      const binding = node.parent.parent;
      if (ts.isVariableDeclaration(binding) && binding.initializer) {
        const key = node.propertyName ?? node.name;
        if (ts.isIdentifier(key) || ts.isStringLiteralLike(key))
          return member(origin(binding.initializer, next), key.text, next);
      }
      // 字面量动态 import 的 then 回调仍按原模块追踪，不能借解构参数藏起值入口。
      if (ts.isParameter(binding) && ts.isArrowFunction(binding.parent)) {
        const callback = binding.parent;
        const call = callback.parent;
        if (
          ts.isCallExpression(call) &&
          ts.isPropertyAccessExpression(call.expression) &&
          call.expression.name.text === "then"
        ) {
          const key = node.propertyName ?? node.name;
          if (ts.isIdentifier(key))
            return member(origin(call.expression.expression, next), key.text, next);
        }
      }
    }
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name)
      return { module: node.getSourceFile().fileName, name: node.name.text };
    return null;
  }

  function origin(expression: ts.Node, seen = new Set<ts.Node>()): ValueOrigin | null {
    const node = unwrap(expression);
    if (seen.has(node)) return null;
    const next = new Set(seen).add(node);
    if (ts.isIdentifier(node)) {
      const local = declaration(node);
      return local ? originOfDeclaration(local, next) : null;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = memberName(node);
      return name ? member(origin(node.expression, next), name, next) : null;
    }
    if (ts.isCallExpression(node)) {
      const callableExpression = unwrap(node.expression);
      // 字面量 require 与动态 import 共享来源；词法绑定存在时它是局部函数，不冒充模块加载。
      const isRequire =
        ts.isIdentifier(callableExpression) &&
        callableExpression.text === "require" &&
        !declaration(callableExpression);
      if (
        (callableExpression.kind === ts.SyntaxKind.ImportKeyword || isRequire) &&
        node.arguments.length === 1 &&
        ts.isStringLiteralLike(node.arguments[0])
      )
        return { module: target(node, node.arguments[0].text), name: "*" };
      const callable = origin(node.expression, next);
      if (
        callable?.module === "drizzle-orm/mysql-core" &&
        callable.name === "alias" &&
        node.arguments[0]
      )
        return origin(node.arguments[0], next);
    }
    return null;
  }

  function literalStates(expression: ts.Node, seen = new Set<ts.Node>()): string[] {
    const node = unwrap(expression);
    if (seen.has(node)) return ["<动态>"];
    const next = new Set(seen).add(node);
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isArrayLiteralExpression(node))
      return [...new Set(node.elements.flatMap((entry) => literalStates(entry, next)))].sort();
    if (ts.isIdentifier(node)) {
      const local = declaration(node);
      if (local && ts.isVariableDeclaration(local) && local.initializer)
        return literalStates(local.initializer, next);
    }
    return ["<动态>"];
  }

  function contains(
    value: ValueOrigin | null,
    module: string,
    name: string,
    seen = new Set<string>(),
  ): boolean {
    if (!value) return false;
    if (value.module === module && value.name === name) return true;
    if (value.name !== "*" || seen.has(value.module)) return false;
    const next = new Set(seen).add(value.module);
    return exportsOf(value.module).some((key) =>
      contains(exportedOrigin(value.module, key, new Set()), module, name, next),
    );
  }

  return { files, origin, declaration, exportsOf, exportedOrigin, contains, literalStates };
}

export type SourceSymbols = ReturnType<typeof sourceSymbols>;
