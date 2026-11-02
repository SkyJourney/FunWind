import { readdirSync, readFileSync } from "node:fs";
import { join, posix, relative } from "node:path";
import ts from "typescript";

export type Sources = Record<string, string>;

export interface ImportEdge {
  specifier: string;
  names: string[];
  namespaceBinding?: string;
  runtime: boolean;
  dynamic: boolean;
  line: number;
}

export interface SourceModule {
  path: string;
  directives: string[];
  imports: ImportEdge[];
}

export function parseModule(path: string, text: string): SourceModule {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const directives: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    directives.push(statement.expression.text);
  }
  const imports: ImportEdge[] = [];
  const add = (
    node: ts.Node,
    specifier: string,
    names: string[],
    runtime: boolean,
    dynamic = false,
  ) => {
    imports.push({
      specifier,
      names,
      runtime,
      dynamic,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const names: string[] = [];
      if (clause?.name) names.push("default");
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        names.push(
          ...bindings.elements
            .filter((entry) => !entry.isTypeOnly)
            .map((entry) => entry.propertyName?.text ?? entry.name.text),
        );
      } else if (bindings) names.push("*");
      const typeOnly =
        clause?.isTypeOnly ||
        (!!bindings &&
          ts.isNamedImports(bindings) &&
          bindings.elements.length > 0 &&
          names.length === 0);
      add(node, node.moduleSpecifier.text, names, !typeOnly);
      if (bindings && ts.isNamespaceImport(bindings))
        imports[imports.length - 1].namespaceBinding = bindings.name.text;
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const clause = node.exportClause;
      const names =
        clause && ts.isNamedExports(clause)
          ? clause.elements
              .filter((entry) => !entry.isTypeOnly)
              .map((entry) => entry.propertyName?.text ?? entry.name.text)
          : ["*"];
      add(node, node.moduleSpecifier.text, names, !node.isTypeOnly && names.length > 0);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const expression = node.moduleReference.expression;
      if (expression && ts.isStringLiteral(expression))
        add(node, expression.text, ["*"], !node.isTypeOnly);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const argument = node.arguments[0];
      if ((isImport || isRequire) && ts.isStringLiteralLike(argument))
        add(node, argument.text, ["*"], true, true);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const collectNamespaceUses = (node: ts.Node) => {
    for (const edge of imports.filter((edge) => edge.runtime && edge.namespaceBinding)) {
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === edge.namespaceBinding
      )
        edge.names.push(node.name.text);
      if (
        ts.isElementAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === edge.namespaceBinding &&
        ts.isStringLiteralLike(node.argumentExpression)
      )
        edge.names.push(node.argumentExpression.text);
    }
    ts.forEachChild(node, collectNamespaceUses);
  };
  collectNamespaceUses(source);
  return { path, directives, imports };
}

export function loadSources(root: string): Sources {
  const sources: Sources = {};
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:ts|tsx|mts)$/.test(path) && !/\.(?:test|spec|d)\.(?:ts|tsx|mts)$/.test(path)) {
        const key = relative(root, path).split("\\").join("/");
        if (!key.startsWith("test/")) sources[key] = readFileSync(path, "utf8");
      }
    }
  };
  walk(root);
  return sources;
}

export function isInternalSpecifier(specifier: string): boolean {
  return specifier.startsWith("@/") || specifier.startsWith(".") || specifier === "cn";
}

export function resolveModule(from: string, specifier: string, sources: Sources): string | null {
  const base =
    specifier === "cn"
      ? "lib/utils"
      : specifier.startsWith("@/")
        ? specifier.slice(2)
        : specifier.startsWith(".")
          ? posix.normalize(posix.join(posix.dirname(from), specifier))
          : null;
  if (base === null) return null;
  const stem = base.replace(/\.(?:js|mjs)$/, "");
  const candidates = [
    base,
    ...[".ts", ".tsx", ".mts", "/index.ts", "/index.tsx"].map((extension) => stem + extension),
  ];
  return candidates.find((candidate) => Object.hasOwn(sources, candidate)) ?? null;
}

export function buildGraph(sources: Sources) {
  const modules = new Map(
    Object.entries(sources).map(([path, text]) => [path, parseModule(path, text)]),
  );
  const graph = new Map<string, string[]>();
  const unresolved: string[] = [];
  for (const [path, source] of modules) {
    const dependencies = new Set<string>();
    for (const edge of source.imports.filter((edge) => edge.runtime)) {
      const target = resolveModule(path, edge.specifier, sources);
      if (target) dependencies.add(target);
      else if (
        isInternalSpecifier(edge.specifier) &&
        !/\.(?:css|svg|png|jpg|gif|webp)$/.test(edge.specifier)
      )
        unresolved.push(`${path}:${edge.line} → ${edge.specifier}`);
    }
    graph.set(path, [...dependencies].sort());
  }
  return { modules, graph, unresolved: unresolved.sort() };
}

/** 返回最短污染路径；Server Action 文件可作为客户端的序列化边界，而非客户端实现依赖。 */
export function findDependencyPath(
  graph: Map<string, string[]>,
  start: string,
  matches: (path: string) => boolean,
  stop: (path: string) => boolean = () => false,
): string[] | null {
  const queue: string[][] = [[start]];
  const seen = new Set([start]);
  for (let index = 0; index < queue.length; index += 1) {
    const path = queue[index];
    const current = path[path.length - 1];
    if (matches(current)) return path;
    if (stop(current)) continue;
    for (const next of graph.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push([...path, next]);
    }
  }
  return null;
}
