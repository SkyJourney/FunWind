// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 守卫：使用模块内核的入口必须自行 `import "@/modules"`（硬约定 9，审查 P2-5）。
 *
 * 为什么：模块注册表（事件消费者、积分渠道声明、槽位）在 `@/modules` 求值时才建立。Server Action 与
 * route handler 各自是独立的服务端入口，不保证注册表已在该上下文求值；没求值时事件只落 `event_log`、
 * 消费者不会被调用——目前没有消费者所以无感，M8 通知订阅后会静默丢通知。
 *
 * 判定（静态分析，纯正则，不执行代码）：
 *  · 「触及内核」的文件 = 非 modules/ 目录下、有运行时（非 `import type`）引用 `@/modules/kernel/*` 的源文件，
 *    也就是会派发事件或读写注册表的代码（lib/authz/admin、lib/gates/unlock、lib/points/apply 等，自动发现，无需维护清单）；
 *  · 「入口」= route.ts 与文件头带 "use server" 的 Server Action 文件（所有会改数据的服务端入口）；
 *  · 入口经**传递**引用（任意层 import）能到达触及内核的文件，就必须直接 `import "@/modules"`。
 * 局限：只看静态 import，动态 `import()` 与按字符串拼路径的引用看不到；页面（page.tsx）只读，不在检查范围。
 */

const SRC = join(__dirname, "../..");

/** 分析一组源码（键 = 相对 src 的 POSIX 路径）。纯函数，便于用合成样例验证守卫本身 */
export function findViolations(sources: Record<string, string>): {
  kernelTouching: string[];
  entries: string[];
  violations: { entry: string; via: string[] }[];
} {
  const keys = new Set(Object.keys(sources));
  const resolveSpec = (from: string, spec: string): string | null => {
    let base: string;
    if (spec.startsWith("@/")) base = spec.slice(2);
    else if (spec.startsWith(".")) {
      const parts = from.split("/").slice(0, -1);
      for (const seg of spec.split("/")) {
        if (seg === "..") parts.pop();
        else if (seg !== ".") parts.push(seg);
      }
      base = parts.join("/");
    } else return null;
    for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
      if (keys.has(c)) return c;
    }
    return null;
  };

  // `import type … from` 不产生运行时依赖，剔除后再分析
  const IMPORT_RE = /(?:import|export)\s+(?!type\b)(?:[^'";]*?\bfrom\s*)?["']([^"']+)["']/g;
  const graph = new Map<string, Set<string>>();
  for (const [file, src] of Object.entries(sources)) {
    const deps = new Set<string>();
    for (const m of src.matchAll(IMPORT_RE)) {
      const r = resolveSpec(file, m[1]!);
      if (r) deps.add(r);
    }
    graph.set(file, deps);
  }

  const touchesKernelRe = /import\s+(?!type\b)[^;]*?from\s*["']@\/modules\/kernel/;
  const kernelTouching = Object.entries(sources)
    .filter(([f, src]) => !f.startsWith("modules/") && touchesKernelRe.test(src))
    .map(([f]) => f)
    .sort();
  const kernelSet = new Set(kernelTouching);

  const isEntry = (f: string, src: string) =>
    /(^|\/)route\.ts$/.test(f) || /^\s*["']use server["']/.test(src);
  const entries = Object.entries(sources)
    .filter(([f, src]) => isEntry(f, src))
    .map(([f]) => f)
    .sort();

  const reach = (start: string): Set<string> => {
    const seen = new Set([start]);
    const stack = [start];
    while (stack.length) {
      for (const d of graph.get(stack.pop()!) ?? []) {
        if (!seen.has(d)) {
          seen.add(d);
          stack.push(d);
        }
      }
    }
    return seen;
  };

  const importsModules = /import\s+["']@\/modules["']/;
  const violations: { entry: string; via: string[] }[] = [];
  for (const e of entries) {
    const r = reach(e);
    const via = kernelTouching.filter((k) => r.has(k));
    // 入口自己触及内核同样要求引入（via 里包含它自己）
    if (via.length > 0 && !importsModules.test(sources[e]!)) violations.push({ entry: e, via });
  }
  return { kernelTouching: [...kernelSet].sort(), entries, violations };
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

function loadSources(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of walk(SRC)) {
    const rel = relative(SRC, p).split(sep).join("/");
    if (/\.test\.tsx?$/.test(rel)) continue;
    out[rel] = readFileSync(p, "utf8");
  }
  return out;
}

describe('入口必须 import "@/modules"（硬约定 9）', () => {
  const result = findViolations(loadSources());

  it("所有 Server Action 与 route handler：凡（传递）引用会触及内核的代码，都直接引入了 @/modules", () => {
    expect(result.violations).toEqual([]);
  });

  it("守卫没有空转：真实仓库里能发现已知的内核触点与入口", () => {
    expect(result.kernelTouching).toEqual(
      expect.arrayContaining(["lib/authz/admin.ts", "lib/gates/unlock.ts", "lib/points/apply.ts"]),
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

  it("modules/ 目录自身不算触及内核；页面不是入口", () => {
    const r = findViolations({
      "modules/kernel/bus.ts": 'import { x } from "@/modules/kernel/registry";\nexport {};',
      "app/p/page.tsx": kernelLib,
    });
    expect(r.kernelTouching).toEqual(["app/p/page.tsx"]);
    expect(r.entries).toEqual([]);
  });
});
