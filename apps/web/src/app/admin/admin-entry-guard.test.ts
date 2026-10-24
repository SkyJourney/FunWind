// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 守卫：`/admin/**` 的每个入口函数，第一个 `await` 必须是 `requireAdmin(...)`（审查 P2-15）。
 *
 * 为什么：Next 的局部渲染可以只请求叶子页面而跳过已持有的 layout，所以 layout 里的鉴权不能代替页面自己的鉴权；
 * Server Action 本就是独立入口。「第一个 await」意味着先鉴权、后读 params / searchParams、再取数——
 * 顺序错了（先取数后鉴权）同样变红。
 *
 * 检查对象：app/admin 下所有 page.tsx / layout.tsx 的默认导出函数，以及 actions.ts 里每个导出的 async 函数。
 * 局限：静态文本分析，只看每个入口函数体里的第一个 await；入口之外新增的文件类型（如 route.ts）不在此检查——
 * 目前 /admin 下没有，若新增须同步扩展。
 */
const ADMIN_DIR = join(__dirname);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** 去掉注释，避免注释里的 await / requireAdmin 干扰判断 */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/** 取入口函数体（从声明起到下一个顶层声明前）里第一个 await 的被调用名 */
export function firstAwaitedCall(body: string): string | null {
  const m = /\bawait\s+([A-Za-z_$][\w$]*)/.exec(body);
  return m ? m[1]! : null;
}

/** 切出每个入口函数的源码片段：key = 函数名（默认导出记为 default） */
export function entryBodies(file: string, src: string): Map<string, string> {
  const text = stripComments(src);
  const out = new Map<string, string>();
  const re = /export\s+(default\s+)?async\s+function\s*([\w$]*)/g;
  const starts: { name: string; at: number }[] = [];
  for (const m of text.matchAll(re)) {
    starts.push({ name: m[1] ? "default" : m[2]!, at: m.index! });
  }
  // actions.ts 里允许存在未导出的辅助函数，所以片段只截到下一个 export 为止
  const next = [...text.matchAll(/\bexport\s/g)].map((m) => m.index!);
  for (const s of starts) {
    const end = next.find((n) => n > s.at + 6) ?? text.length;
    out.set(s.name, text.slice(s.at, end));
  }
  if (out.size === 0 && /\b(page|layout|actions)\.tsx?$/.test(file)) out.set("(none)", "");
  return out;
}

const files = walk(ADMIN_DIR)
  .filter((p) => /(^|[\\/])(page|layout)\.tsx$|(^|[\\/])actions\.ts$/.test(p))
  .map((p) => ({ rel: relative(ADMIN_DIR, p).split(sep).join("/"), src: readFileSync(p, "utf8") }));

describe("/admin 入口必须先鉴权（审查 P2-15）", () => {
  it("守卫没有空转：能发现后台的 layout、全部页面和 Server Action", () => {
    const names = files.map((f) => f.rel);
    expect(names).toEqual(
      expect.arrayContaining([
        "layout.tsx",
        "page.tsx",
        "actions.ts",
        "authz/page.tsx",
        "authz/[roleKey]/page.tsx",
        "authz/forum/[fid]/page.tsx",
      ]),
    );
  });

  it("每个入口函数的第一个 await 都是 requireAdmin", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const bodies = entryBodies(f.rel, f.src);
      for (const [name, body] of bodies) {
        if (firstAwaitedCall(body) !== "requireAdmin") offenders.push(`${f.rel} › ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("actions.ts 里的导出函数不止一个（守卫确实逐个检查了每个动作）", () => {
    const actions = files.find((f) => f.rel === "actions.ts")!;
    expect(entryBodies(actions.rel, actions.src).size).toBeGreaterThanOrEqual(4);
  });
});

describe("firstAwaitedCall / entryBodies 自身", () => {
  it("先取数后鉴权、完全没鉴权、鉴权在注释里 都会被识别为违规", () => {
    const bad1 =
      "export default async function P() { const x = await getData(); await requireAdmin(); }";
    const bad2 = "export default async function P() { return 1; }";
    const bad3 = "export default async function P() { // await requireAdmin()\n await getData(); }";
    const good =
      "export default async function P() { await requireAdmin('admin.roles'); await getData(); }";
    const first = (s: string) => firstAwaitedCall(entryBodies("x/page.tsx", s).get("default")!);
    expect(first(bad1)).toBe("getData");
    expect(first(bad2)).toBeNull();
    expect(first(bad3)).toBe("getData");
    expect(first(good)).toBe("requireAdmin");
  });

  it("多个导出函数互不串味：后一个函数里的 requireAdmin 不能替前一个背书", () => {
    const src =
      "export async function a() { await doIt(); }\nexport async function b() { await requireAdmin(); }";
    const m = entryBodies("actions.ts", src);
    expect(firstAwaitedCall(m.get("a")!)).toBe("doIt");
    expect(firstAwaitedCall(m.get("b")!)).toBe("requireAdmin");
  });
});
