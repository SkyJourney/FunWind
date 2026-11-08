// @vitest-environment node
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildGraph,
  findDependencyPath,
  isInternalSpecifier,
  loadSources,
  parseModule,
  resolveModule,
  type Sources,
} from "./source-graph";

const SRC = join(import.meta.dirname, "..");

function forbiddenEdges(sources: Sources): string[] {
  const { modules } = buildGraph(sources);
  const violations: string[] = [];
  for (const [path, source] of modules) {
    for (const edge of source.imports.filter((entry) => entry.runtime)) {
      const target = resolveModule(path, edge.specifier, sources);
      if (!target) continue;
      const bad =
        (path.startsWith("lib/authz/") && target.startsWith("lib/queries/")) ||
        (path.startsWith("lib/uploads/") && target.startsWith("lib/posting/")) ||
        (/^lib\/[^/]+\.tsx?$/.test(path) && /^lib\/[^/]+\//.test(target)) ||
        (path.startsWith("lib/") && target.startsWith("components/")) ||
        (path.startsWith("modules/") && target.startsWith("app/")) ||
        ((path.startsWith("components/") ||
          (path.startsWith("app/") && !path.startsWith("app/admin/"))) &&
          target.startsWith("app/admin/") &&
          /\/actions\.ts$/.test(target)) ||
        (path.startsWith("components/") &&
          target.startsWith("app/") &&
          !target.startsWith("app/actions/") &&
          /actions\.ts$/.test(target));
      if (bad) violations.push(`${path}:${edge.line} → ${target}`);
    }
  }
  return violations.sort();
}

function missingOutboxFastPath(sources: Sources): string[] {
  return [...buildGraph(sources).modules.values()]
    .filter((source) => {
      const edges = source.imports.filter(
        (edge) =>
          edge.runtime &&
          resolveModule(source.path, edge.specifier, sources) === "lib/events/outbox.ts",
      );
      return (
        edges.some((edge) => edge.names.includes("enqueueEventInTx")) &&
        !edges.some((edge) => edge.names.includes("dispatchOutboxRows"))
      );
    })
    .map((source) => source.path)
    .sort();
}

function databaseEntries(sources: Sources): string[] {
  return [...buildGraph(sources).modules.values()]
    .filter(
      (source) =>
        source.path.startsWith("app/") &&
        source.imports.some((edge) => edge.runtime && edge.specifier === "@funwind/db"),
    )
    .map((source) => source.path)
    .sort();
}

// 存量入口的显式基线；新增直连必须在评审中说明理由，不能靠遗漏动态 import 绕过。
const DATABASE_ENTRIES = [
  "app/actions/auth.ts",
  "app/actions/posts.ts",
  "app/admin/announcements/actions.ts",
  "app/admin/announcements/page.tsx",
  "app/admin/decor/actions.ts",
  "app/admin/emojis/actions.ts",
  "app/admin/emojis/page.tsx",
  "app/admin/forums/actions.ts",
  "app/admin/forums/page.tsx",
  "app/admin/review/actions.ts",
  "app/admin/settings/actions.ts",
  "app/admin/settings/page.tsx",
  "app/api/dev/whoami/route.ts",
  "app/api/emojis/route.ts",
  // M13 Step 1：健康端点直连 db 做 SELECT 1 拨测探针（D3）；只暴露布尔位不泄露细节
  "app/api/health/route.ts",
  "app/api/settings/preferences/route.ts",
  "app/p/[pid]/hide/page.tsx",
  "app/settings/actions.ts",
  "app/settings/email/page.tsx",
  "app/settings/notifications/page.tsx",
  "app/settings/page.tsx",
  "app/settings/pm/page.tsx",
  "app/settings/profile/page.tsx",
  "app/sitemap.ts",
  "app/u/[uid]/page.tsx",
].sort();

const sources = loadSources(SRC);
const realGraph = buildGraph(sources);

describe("架构边界（G-02/G-03/G-04/G-08）", () => {
  it("运行时内部导入都能解析，移动文件后不能残留旧路径", () => {
    expect(realGraph.unresolved).toEqual([]);
  });
  it("实际业务依赖不包含已禁止回边", () => expect(forbiddenEdges(sources)).toEqual([]));
  it("app 数据库直连入口与评审基线一致", () =>
    expect(databaseEntries(sources)).toEqual(DATABASE_ENTRIES));
  it("所有 outbox 生产方均声明本次事件快路径", () => {
    expect(missingOutboxFastPath(sources)).toEqual([]);
    expect(
      [...realGraph.modules.values()].filter((source) =>
        source.imports.some((edge) => edge.names.includes("enqueueEventInTx")),
      ).length,
    ).toBeGreaterThan(10);
  });
});

describe("导入图自身", () => {
  it("识别真实导入、混合类型、转发、别名与动态导入，忽略注释和字符串", () => {
    const parsed = parseModule(
      "x.ts",
      `"use client";
      // import { getWebDb } from '@funwind/db';
      import type { A } from './a';
      import { type B } from './b';
      import { type C, value as alias } from './c';
      export type { D } from './d';
      export { type E, value as renamed } from './e';
      const text = "import './fake'";
      const next = import('./next');
      const node = require('./node');`,
    );
    expect(parsed.directives).toEqual(["use client"]);
    expect(
      parsed.imports.filter((edge) => edge.runtime).map((edge) => [edge.specifier, edge.names]),
    ).toEqual([
      ["./c", ["value"]],
      ["./e", ["value"]],
      ["./next", ["*"]],
      ["./node", ["*"]],
    ]);
  });
  it("通过相对路径、index、别名和 js 后缀定位真实文件；未知内部路径不静默丢弃", () => {
    const input = {
      "lib/a.ts": "import './missing'; import './style.css';",
      "lib/b/index.ts": "",
      "lib/c.tsx": "",
      "lib/utils.ts": "",
    };
    expect(resolveModule("lib/a.ts", "./b", input)).toBe("lib/b/index.ts");
    expect(resolveModule("lib/a.ts", "@/lib/c.js", input)).toBe("lib/c.tsx");
    expect(resolveModule("lib/a.ts", "cn", input)).toBe("lib/utils.ts");
    expect(isInternalSpecifier("react")).toBe(false);
    expect(buildGraph(input).unresolved).toEqual(["lib/a.ts:1 → ./missing"]);
  });
  it.each([
    ["lib/authz/a.ts", "lib/queries/x.ts"],
    ["lib/uploads/a.ts", "lib/posting/x.ts"],
    ["lib/root.ts", "lib/pm/x.ts"],
    ["lib/posting/a.ts", "components/editor/x.ts"],
    ["modules/a.ts", "app/actions/x.ts"],
    ["components/a.ts", "app/admin/review/actions.ts"],
    ["components/a.ts", "app/settings/actions.ts"],
    ["app/t/page.tsx", "app/admin/review/actions.ts"],
  ])("静态与动态引用都不能绕过 %s → %s", (from, to) => {
    for (const body of [
      `import { x } from '@/\u005fTARGET';`,
      `export { x } from '@/\u005fTARGET';`,
      `const x = import('@/\u005fTARGET');`,
    ]) {
      const input = {
        [from]: body.replace("_TARGET", to.replace(/\.tsx?$/, "")),
        [to]: "export const x = 1",
      };
      expect(forbiddenEdges(input)).toHaveLength(1);
    }
    expect(
      forbiddenEdges({
        [from]: `import type { X } from '@/${to.replace(/\.tsx?$/, "")}';`,
        [to]: "",
      }),
    ).toEqual([]);
  });
  it("outbox 别名按导出名识别；无快路径、只有注释都不合规", () => {
    const producer = "import { enqueueEventInTx as enqueue } from '@/lib/events/outbox';";
    const input = { "lib/x.ts": producer, "lib/events/outbox.ts": "" };
    expect(missingOutboxFastPath(input)).toEqual(["lib/x.ts"]);
    expect(
      missingOutboxFastPath({ ...input, "lib/x.ts": producer + "// dispatchOutboxRows" }),
    ).toEqual(["lib/x.ts"]);
    expect(
      missingOutboxFastPath({
        ...input,
        "lib/x.ts": producer + "import { dispatchOutboxRows as dispatch } from './events/outbox';",
      }),
    ).toEqual([]);
    const namespaced = "import * as outbox from '@/lib/events/outbox'; outbox.enqueueEventInTx();";
    expect(missingOutboxFastPath({ ...input, "lib/x.ts": namespaced })).toEqual(["lib/x.ts"]);
    expect(
      missingOutboxFastPath({
        ...input,
        "lib/x.ts": namespaced + "outbox['dispatchOutboxRows']();",
      }),
    ).toEqual([]);
  });
  it("app 数据库基线识别动态引入，不计 type-only", () => {
    expect(
      databaseEntries({
        "app/a/route.ts": "const db = import('@funwind/db');",
        "app/b/route.ts": "import type { User } from '@funwind/db';",
      }),
    ).toEqual(["app/a/route.ts"]);
  });
  it("污染路径跨转发与动态依赖，允许在 Server Action 序列化边界停止", () => {
    const input = {
      "components/a.tsx": "'use client'; import { x } from '@/lib/barrel';",
      "lib/barrel.ts": "export { x } from './io';",
      "lib/io.ts": "import 'server-only';",
    };
    const { graph } = buildGraph(input);
    expect(findDependencyPath(graph, "components/a.tsx", (path) => path === "lib/io.ts")).toEqual([
      "components/a.tsx",
      "lib/barrel.ts",
      "lib/io.ts",
    ]);
    expect(findDependencyPath(graph, "components/a.tsx", () => false)).toBeNull();
    expect(
      findDependencyPath(
        graph,
        "components/a.tsx",
        (path) => path === "lib/io.ts",
        (path) => path === "lib/barrel.ts",
      ),
    ).toBeNull();
  });
});
