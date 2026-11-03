// @vitest-environment node
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGraph, loadSources, resolveModule } from "@/test/source-graph";

/**
 * 使用内核的 Action/route 必须在加载时静态求值注册表，动态触点也计入依赖图。
 * 动态 import 注册表不等于已初始化；任意拼接路径不做数据流推断，由入口业务回归补充。
 */
const SRC = join(import.meta.dirname, "../..");

export function findViolations(sources: Record<string, string>): {
  kernelTouching: string[];
  entries: string[];
  violations: { entry: string; via: string[] }[];
} {
  const { modules, graph } = buildGraph(sources);
  const eagerGraph = new Map<string, string[]>();
  const kernelTouching: string[] = [];
  const entries: string[] = [];
  const registryLoaders = new Set<string>();
  for (const [path, source] of modules) {
    const runtime = source.imports.filter((edge) => edge.runtime);
    eagerGraph.set(
      path,
      runtime
        .filter((edge) => !edge.dynamic)
        .flatMap((edge) => {
          const target = resolveModule(path, edge.specifier, sources);
          return target ? [target] : [];
        }),
    );
    if (
      !path.startsWith("modules/") &&
      runtime.some(
        (edge) =>
          edge.specifier.startsWith("@/modules/kernel/") ||
          resolveModule(path, edge.specifier, sources)?.startsWith("modules/kernel/"),
      )
    )
      kernelTouching.push(path);
    if (/(^|\/)route\.(?:ts|mts)$/.test(path) || source.directives.includes("use server"))
      entries.push(path);
    if (
      runtime.some(
        (edge) =>
          !edge.dynamic &&
          (edge.specifier === "@/modules" ||
            resolveModule(path, edge.specifier, sources) === "modules/index.ts"),
      )
    )
      registryLoaders.add(path);
  }
  kernelTouching.sort();
  entries.sort();
  const reach = (start: string, dependencies: Map<string, string[]>) => {
    const seen = new Set([start]);
    const stack = [start];
    while (stack.length) {
      for (const next of dependencies.get(stack.pop()!) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    return seen;
  };
  const violations: { entry: string; via: string[] }[] = [];
  for (const entry of entries) {
    const reachable = reach(entry, graph);
    const via = kernelTouching.filter((path) => reachable.has(path));
    const initialized = [...reach(entry, eagerGraph)].some((path) => registryLoaders.has(path));
    if (via.length > 0 && !initialized) violations.push({ entry, via });
  }
  return { kernelTouching, entries, violations };
}

describe('入口必须 import "@/modules"（硬约定 9）', () => {
  const result = findViolations(loadSources(SRC));

  it('所有 Server Action 与 route handler：凡（传递）引用会触及内核的代码，自己或其传递依赖里都有 import "@/modules"', () => {
    expect(result.violations).toEqual([]);
  });

  it("守卫没有空转：真实仓库里能发现已知的内核触点与入口", () => {
    expect(result.kernelTouching).toEqual(
      expect.arrayContaining(["lib/events/outbox.ts", "lib/points/apply.ts"]),
    );
    expect(result.entries).toEqual(
      expect.arrayContaining([
        "app/actions/auth.ts",
        "app/actions/gates.ts",
        "app/admin/actions.ts",
        "app/files/[...key]/route.ts",
      ]),
    );
  });
});

describe("findViolations 自身（合成样例）", () => {
  const kernelLib = 'import { emit } from "@/modules/kernel/bus";\nexport const f = () => emit();';
  const action = (body: string) => `"use server";\n${body}\nexport async function a() {}`;

  it("入口直接引用触及内核的 lib 却没引入 @/modules → 违规", () => {
    const r = findViolations({
      "lib/x.ts": kernelLib,
      "app/a/actions.ts": action('import { f } from "@/lib/x";'),
    });
    expect(r.violations).toEqual([{ entry: "app/a/actions.ts", via: ["lib/x.ts"] }]);
  });

  it('补上 import "@/modules" 后通过', () => {
    const r = findViolations({
      "lib/x.ts": kernelLib,
      "app/a/actions.ts": action('import "@/modules";\nimport { f } from "@/lib/x";'),
    });
    expect(r.violations).toEqual([]);
  });

  it("经包装函数（如 defineAction）引入 @/modules 同样合规；对照：包装函数没引入则违规；引入了但入口并不引用它也违规", () => {
    const wrapperWith = 'import "@/modules";\nexport const defineAction = (f: unknown) => f;';
    const wrapperWithout = "export const defineAction = (f: unknown) => f;";
    const entry = (w: string) =>
      action(`import { defineAction } from "@/lib/${w}";\nimport { f } from "@/lib/x";`);
    expect(
      findViolations({
        "lib/x.ts": kernelLib,
        "lib/wrap.ts": wrapperWith,
        "app/a/actions.ts": entry("wrap"),
      }).violations,
    ).toEqual([]);
    expect(
      findViolations({
        "lib/x.ts": kernelLib,
        "lib/wrap.ts": wrapperWithout,
        "app/a/actions.ts": entry("wrap"),
      }).violations,
    ).toEqual([{ entry: "app/a/actions.ts", via: ["lib/x.ts"] }]);
    // 有人引入了 @/modules，但这个入口并不（传递）引用它：不算数
    expect(
      findViolations({
        "lib/x.ts": kernelLib,
        "lib/wrap.ts": wrapperWithout,
        "lib/other.ts": 'import "@/modules";\nexport {};',
        "app/a/actions.ts": entry("wrap"),
      }).violations,
    ).toEqual([{ entry: "app/a/actions.ts", via: ["lib/x.ts"] }]);
  });

  it('注释不算数：注释里写着 import "@/modules"，或把 import 注释掉了，都不能让入口合规', () => {
    const commented =
      '/** 本文件顶部有 import "@/modules" */\n// import "@/modules";\nexport const defineAction = (f: unknown) => f;';
    const r = findViolations({
      "lib/x.ts": kernelLib,
      "lib/wrap.ts": commented,
      "app/a/actions.ts": action(
        'import { defineAction } from "@/lib/wrap";\nimport { f } from "@/lib/x";',
      ),
    });
    expect(r.violations).toEqual([{ entry: "app/a/actions.ts", via: ["lib/x.ts"] }]);
    // 对照：真正的 import 写在注释之后仍然有效
    const real = findViolations({
      "lib/x.ts": kernelLib,
      "lib/wrap.ts": '// 说明\nimport "@/modules";\nexport const defineAction = (f: unknown) => f;',
      "app/a/actions.ts": action(
        'import { defineAction } from "@/lib/wrap";\nimport { f } from "@/lib/x";',
      ),
    });
    expect(real.violations).toEqual([]);
  });

  it("传递引用（入口 → 中间层 → 触及内核的 lib，含相对路径）同样违规", () => {
    const r = findViolations({
      "lib/x.ts": kernelLib,
      "lib/mid.ts": 'import { f } from "./x";\nexport const g = f;',
      "app/b/route.ts": 'import { g } from "@/lib/mid";\nexport const GET = g;',
    });
    expect(r.violations).toEqual([{ entry: "app/b/route.ts", via: ["lib/x.ts"] }]);
  });

  it("不触及内核的入口不要求；只用 `import type` 引内核类型的文件不算触及", () => {
    const r = findViolations({
      "lib/types-only.ts":
        'import type { EventPayloads } from "@/modules/kernel/types";\nexport {};',
      "app/c/actions.ts": action('import "@/lib/types-only";'),
      "app/d/route.ts": "export const GET = () => 1;",
    });
    expect(r.kernelTouching).toEqual([]);
    expect(r.violations).toEqual([]);
  });

  it("动态触点同样需要静态初始化；动态加载注册表不能冒充启动保障", () => {
    const entry = action("const next = import('@/lib/x');");
    const input = { "lib/x.ts": kernelLib, "app/a/actions.ts": entry };
    expect(findViolations(input).violations).toEqual([
      { entry: "app/a/actions.ts", via: ["lib/x.ts"] },
    ]);
    expect(
      findViolations({
        ...input,
        "app/a/actions.ts": entry + "\nconst registry = import('@/modules');",
      }).violations,
    ).toHaveLength(1);
    expect(
      findViolations({ ...input, "app/a/actions.ts": entry + "\nimport '@/modules';" }).violations,
    ).toEqual([]);
  });

  it("通过动态中间层加载初始化器，不算入口加载时已初始化", () => {
    const input = {
      "lib/x.ts": kernelLib,
      "lib/init.ts": "import '@/modules'; export const value = 1;",
      "app/a/actions.ts": action("import '@/lib/x'; const init = import('@/lib/init');"),
    };
    expect(findViolations(input).violations).toHaveLength(1);
    expect(
      findViolations({
        ...input,
        "app/a/actions.ts": action("import '@/lib/x'; import '@/lib/init';"),
      }).violations,
    ).toEqual([]);
  });

  it("modules/ 目录自身不算触及内核；页面不是入口", () => {
    const r = findViolations({
      "modules/kernel/bus.ts": 'import { x } from "@/modules/kernel/registry";\nexport {};',
      "app/p/page.tsx": kernelLib,
    });
    expect(r.kernelTouching).toEqual(["app/p/page.tsx"]);
    expect(r.entries).toEqual([]);
  });
});
