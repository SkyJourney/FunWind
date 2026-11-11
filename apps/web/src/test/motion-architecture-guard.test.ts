// @vitest-environment node
import { join, posix } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { loadSources, parseModule, resolveModule, type Sources } from "./source-graph";

const SRC = join(import.meta.dirname, "..");
const MOTION = "lib/motion";
const ENGINE = `${MOTION}/engine`;
const ENTRY = `${MOTION}/index.ts`;
const LEGACY_ENTRIES = new Set([
  `${MOTION}/nav-kind.ts`,
  `${MOTION}/nav-guard.ts`,
  `${MOTION}/view-transition.ts`,
]);

function within(path: string, directory: string): boolean {
  return path === directory || path.startsWith(`${directory}/`);
}

function isCore(path: string): boolean {
  return within(path, ENGINE) || path === ENTRY;
}

function moduleReference(from: string, specifier: string, sources: Sources) {
  // 先归一化路径再复用解析器；不存在的内部目标仍保留路径，不能绕过深导守卫。
  const path = specifier.startsWith("@/")
    ? posix.normalize(specifier.slice(2))
    : specifier.startsWith(".")
      ? posix.normalize(posix.join(posix.dirname(from), specifier))
      : null;
  const target = resolveModule(from, path === null ? specifier : `@/${path}`, sources);
  return { target, path: target ?? path?.replace(/\.(?:js|mjs)$/, "") ?? null };
}

function isReactAdapterDependency(specifier: string): boolean {
  // 只为 React 官方包保留类型与未来适配层的值导入，不放行名称相似的第三方包。
  return ["react", "react-dom"].some(
    (name) => specifier === name || specifier.startsWith(`${name}/`),
  );
}

function inspectOtherLoads(path: string, text: string) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const imports: { specifier: string; line: number }[] = [];
  const unsupported: string[] = [];
  const core = isCore(path);
  const lineOf = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const reject = (node: ts.Node) =>
    unsupported.push(`${path}:${lineOf(node)} → 无法静态解析的内核模块加载`);
  const visit = (node: ts.Node) => {
    // 公共 helper 尚不收集类型查询及带选项的动态导入；这里只补充其字面量依赖。
    if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal))
        imports.push({ specifier: argument.literal.text, line: lineOf(node) });
      else if (core) reject(node);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      const literal = argument && ts.isStringLiteralLike(argument);
      if (node.arguments.length !== 1 && literal)
        imports.push({ specifier: argument.text, line: lineOf(node) });
      if (core && (node.arguments.length !== 1 || !literal)) reject(node);
    }
    // 内核只接受 helper 能识别的直接字面量 require；别名和成员访问也不静默放行。
    if (core && ts.isIdentifier(node) && node.text === "require") {
      const parent = node.parent;
      if (
        !ts.isCallExpression(parent) ||
        parent.expression !== node ||
        parent.arguments.length !== 1 ||
        !ts.isStringLiteralLike(parent.arguments[0])
      )
        reject(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { imports, unsupported };
}

function motionViolations(sources: Sources): string[] {
  const violations: string[] = [];
  for (const [path, text] of Object.entries(sources)) {
    const parsed = parseModule(path, text);
    const other = inspectOtherLoads(path, text);
    violations.push(...other.unsupported);
    // 类型边同样属于架构依赖，不能像运行时污染守卫那样过滤 runtime。
    for (const edge of [...parsed.imports, ...other.imports]) {
      const reference = moduleReference(path, edge.specifier, sources);
      if (isCore(path)) {
        if (
          !(reference.target && isCore(reference.target)) &&
          !isReactAdapterDependency(edge.specifier)
        )
          violations.push(
            `${path}:${edge.line} → ${reference.path ?? edge.specifier}（内核只能依赖 engine、公开入口或 React 适配包）`,
          );
      } else if (
        reference.path &&
        within(reference.path, MOTION) &&
        reference.path !== MOTION &&
        reference.path !== `${MOTION}/index` &&
        reference.path !== ENTRY &&
        !LEGACY_ENTRIES.has(reference.path)
      )
        violations.push(
          `${path}:${edge.line} → ${reference.path}（新动效模块只能经 motion/index 访问）`,
        );
    }
  }
  return violations.sort();
}

const CORE = `${ENGINE}/core.ts`;
const HELPER = `${ENGINE}/nested/helper.ts`;
const CONSUMER = "components/motion-consumer.tsx";
const EXPORTS = "export const value = 1; export type Value = number;";

function fixture(overrides: Sources = {}): Sources {
  return {
    [ENTRY]: 'export { value } from "./engine/core";',
    [CORE]: EXPORTS,
    [HELPER]: EXPORTS,
    [`${MOTION}/nav-kind.ts`]: EXPORTS,
    [`${MOTION}/nav-guard.ts`]: 'import "./nav-kind";',
    [`${MOTION}/view-transition.ts`]: EXPORTS,
    ...overrides,
  };
}

function relativeSpecifier(from: string, target: string): string {
  const path = posix.relative(posix.dirname(from), target).replace(/\.(?:ts|tsx|mts)$/, "");
  return path.startsWith(".") ? path : `./${path}`;
}

const IMPORT_FORMS = [
  "import value from MODULE;",
  "import { value as renamed } from MODULE;",
  "import * as values from MODULE;",
  "import MODULE;",
  "import type { Value } from MODULE;",
  "import { type Value } from MODULE;",
  "import { type Value, value as renamed } from MODULE;",
  "export { value as renamed } from MODULE;",
  "export * from MODULE;",
  "export * as values from MODULE;",
  "export type { Value } from MODULE;",
  "export type * from MODULE;",
  "export { type Value } from MODULE;",
  "export { type Value, value as renamed } from MODULE;",
  "import values = require(MODULE);",
  "import type values = require(MODULE);",
  "void import(MODULE);",
  "const values = require(MODULE);",
];

const sources = loadSources(SRC);

describe("M15 Step 1 动效架构边界", () => {
  it("真实扫描包含新内核、公开入口及其真实导出，不允许空图假通过", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(0);
    expect(Object.keys(sources).filter((path) => within(path, ENGINE)).length).toBeGreaterThan(0);
    expect(Object.hasOwn(sources, ENTRY)).toBe(true);
    const exports = parseModule(ENTRY, sources[ENTRY] ?? "").imports;
    expect(
      exports.some((edge) => {
        const target = resolveModule(ENTRY, edge.specifier, sources);
        return target !== null && within(target, ENGINE);
      }),
    ).toBe(true);
  });

  it("真实内核无反向依赖，外部消费者只经公开入口访问新动效模块", () => {
    expect(motionViolations(sources)).toEqual([]);
  });

  it("真实旧兼容入口和消费者仍被扫描，但不要求本步迁移", () => {
    for (const entry of LEGACY_ENTRIES) expect(Object.hasOwn(sources, entry), entry).toBe(true);
    expect(
      Object.entries(sources).some(([path, text]) =>
        parseModule(path, text).imports.some((edge) => {
          const target = resolveModule(path, edge.specifier, sources);
          return target !== null && LEGACY_ENTRIES.has(target);
        }),
      ),
    ).toBe(true);
  });
});

describe("动效架构守卫自身：内核隔离", () => {
  it.each(IMPORT_FORMS)("静态、类型和动态边都不能反向依赖：%s", (template) => {
    for (const from of [CORE, ENTRY]) {
      for (const target of [
        "app/actions/business.ts",
        "components/site/business.tsx",
        "modules/business/index.ts",
        "lib/auth/session.ts",
        "lib/utils.ts",
        ...LEGACY_ENTRIES,
      ]) {
        for (const specifier of [
          `@/${target.replace(/\.(?:ts|tsx)$/, "")}`,
          relativeSpecifier(from, target),
          ...(target === "lib/utils.ts" ? ["cn"] : []),
        ]) {
          const body = template.replace("MODULE", JSON.stringify(specifier));
          expect(
            motionViolations(fixture({ [target]: EXPORTS, [from]: body })),
            `${from}：${body}`,
          ).toEqual([expect.stringContaining(`${from}:1 → ${target}`)]);
        }
      }
    }
  });

  it.each(IMPORT_FORMS)("外部业务包和平台包也不能靠类型边绕过：%s", (template) => {
    for (const from of [CORE, ENTRY]) {
      for (const specifier of [
        "@funwind/db",
        "@funwind/db/schema",
        "@funwind/content",
        "next",
        "next/navigation",
        "server-only",
        "node:fs",
        "framer-motion",
        "react-query",
      ]) {
        const body = template.replace("MODULE", JSON.stringify(specifier));
        expect(motionViolations(fixture({ [from]: body })), `${from}：${body}`).toEqual([
          expect.stringContaining(`${from}:1 → ${specifier}`),
        ]);
      }
    }
  });

  it.each(IMPORT_FORMS)("允许内核互引和公开入口转发，但不扩大内部依赖范围：%s", (template) => {
    for (const from of [CORE, ENTRY]) {
      for (const specifier of [
        "@/lib/motion/engine/nested/helper",
        "@/lib/motion/engine/nested/../nested/helper.js",
        relativeSpecifier(from, HELPER),
        "@/lib/motion/index",
      ]) {
        const body = template.replace("MODULE", JSON.stringify(specifier));
        expect(motionViolations(fixture({ [from]: body })), `${from}：${body}`).toEqual([]);
      }
    }
  });

  it.each(IMPORT_FORMS)("React 类型及未来官方适配值导入不被误禁：%s", (template) => {
    for (const from of [CORE, ENTRY]) {
      for (const specifier of ["react", "react/jsx-runtime", "react-dom", "react-dom/client"]) {
        const body = template.replace("MODULE", JSON.stringify(specifier));
        expect(motionViolations(fixture({ [from]: body })), `${from}：${body}`).toEqual([]);
      }
    }
  });

  it.each([
    "@/lib/motion/engine/missing",
    "./missing",
    "@/lib/motion/engine/../nav-kind",
    "./styles.css",
  ])("未解析内部依赖不能静默通过：%s", (specifier) => {
    expect(
      motionViolations(fixture({ [CORE]: `import ${JSON.stringify(specifier)};` })),
    ).toHaveLength(1);
  });

  it.each([
    "void import(moduleName);",
    "void import(`./${moduleName}`);",
    'void import("./" + moduleName);',
    'void import("react", { with: { type: "json" } });',
    "const values = require(moduleName);",
    'const values = require("react", options);',
    "const load = require;",
    'const values = module.require("react");',
    'const path = require.resolve("react");',
  ])("内核无法静态解析的加载形式明确拒绝：%s", (body) => {
    for (const from of [CORE, ENTRY])
      expect(motionViolations(fixture({ [from]: body })), from).toEqual([
        expect.stringContaining("无法静态解析的内核模块加载"),
      ]);
  });
});

describe("动效架构守卫自身：唯一公开入口与旧链豁免", () => {
  it.each(IMPORT_FORMS)("禁止任何导入形态从外部深导 engine：%s", (template) => {
    for (const specifier of [
      "@/lib/motion/engine/core",
      "../lib/motion/engine/core",
      "@/lib/motion/engine/core.ts",
      "@/lib/motion/engine/core.js",
      "@/lib/motion/engine/core.mjs",
      "@/lib/../lib/motion/engine/core",
      "../lib/motion/engine/nested/../core",
      "@/lib/motion/engine",
      "../lib/motion/engine/index.js",
      "@/lib/motion/engine/missing",
    ]) {
      const body = template.replace("MODULE", JSON.stringify(specifier));
      const input = fixture({
        [`${ENGINE}/index.ts`]: 'export * from "./core";',
        [CONSUMER]: body,
      });
      expect(motionViolations(input), body).toEqual([
        expect.stringContaining(`${CONSUMER}:1 → ${ENGINE}/`),
      ]);
    }
  });

  it.each([
    "app/example/page.tsx",
    "components/site/example.tsx",
    "modules/example/index.ts",
    "lib/example.ts",
    `${MOTION}/future-adapter.tsx`,
    ...LEGACY_ENTRIES,
  ])("消费者路径不构成深导豁免，旧兼容文件也不能深导：%s", (from) => {
    const body = `import type { Value } from "${relativeSpecifier(from, CORE)}";`;
    expect(motionViolations(fixture({ [from]: body })), from).toEqual([
      expect.stringContaining(`${from}:1 → ${CORE}`),
    ]);
  });

  it.each(IMPORT_FORMS)("新消费者可经 alias 或相对路径访问公开入口：%s", (template) => {
    for (const specifier of [
      "@/lib/motion",
      "@/lib/motion/index",
      "@/lib/motion/index.ts",
      "../lib/motion",
      "../lib/motion/index.js",
      "../lib/motion/index.mjs",
    ]) {
      const body = template.replace("MODULE", JSON.stringify(specifier));
      expect(motionViolations(fixture({ [CONSUMER]: body })), body).toEqual([]);
    }
  });

  it.each(IMPORT_FORMS)("旧进口继续兼容，不禁止旧消费者：%s", (template) => {
    for (const target of LEGACY_ENTRIES) {
      for (const specifier of [
        `@/${target.replace(/\.ts$/, "")}`,
        relativeSpecifier(CONSUMER, target),
      ]) {
        const body = template.replace("MODULE", JSON.stringify(specifier));
        expect(motionViolations(fixture({ [CONSUMER]: body })), body).toEqual([]);
      }
    }
  });

  it("旧兼容链仍可依赖现有业务或平台模块，不能把旧链误当新内核", () => {
    expect(
      motionViolations(
        fixture({
          [`${MOTION}/nav-kind.ts`]: 'import type { Value } from "@/lib/business";',
          [`${MOTION}/nav-guard.ts`]: 'import "./nav-kind"; import "next/navigation";',
          [`${MOTION}/view-transition.ts`]: 'import "@funwind/db";',
          "lib/business.ts": EXPORTS,
          [CONSUMER]: 'import "@/lib/motion/nav-guard";',
        }),
      ),
    ).toEqual([]);
  });

  it("不存在的 engine 目录进口及新增根级私有模块也不能成为第二公开入口", () => {
    for (const specifier of ["@/lib/motion/engine", "@/lib/motion/future-adapter"]) {
      expect(
        motionViolations(fixture({ [CONSUMER]: `export * from "${specifier}";` })),
      ).toHaveLength(1);
    }
  });

  it.each([
    'type Value = import("MODULE").Value;',
    'type Value = typeof import("MODULE");',
    'void import("MODULE", { with: { type: "json" } });',
    "void import(`MODULE`);",
    "const values = require(`MODULE`);",
  ])("字面量类型查询、动态导入选项和模板字面量同样守住入口：%s", (template) => {
    const body = template.replace("MODULE", "@/lib/motion/engine/core");
    expect(motionViolations(fixture({ [CONSUMER]: body })), body).toEqual([
      expect.stringContaining(`${CONSUMER}:1 → ${CORE}`),
    ]);
    const business = template.replace("MODULE", "@funwind/db");
    expect(motionViolations(fixture({ [CORE]: business })), business).not.toEqual([]);
  });

  it("注释、普通字符串与未执行模板中的导入文本不会产生假依赖", () => {
    const harmless = `
      // 中文说明：import "@/lib/motion/engine/core"; require(moduleName);
      /* 中文说明：export * from "@/app/business"; import("@funwind/db"); */
      const example = "import { value } from '@/lib/motion/engine/core';";
      const other = 'require("@funwind/db")';
      const template = \`import("@/lib/motion/engine/core")\`;
      const object = { import: (name: string) => name };
      object.import("@funwind/db");
      export {};
    `;
    expect(
      motionViolations(fixture({ [CORE]: harmless, [ENTRY]: harmless, [CONSUMER]: harmless })),
    ).toEqual([]);
  });
});
