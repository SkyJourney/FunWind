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
 * 检查对象：app/admin 下所有 page.tsx / layout.tsx 的默认导出函数，以及 actions.ts 里每个入口：
 *   · `export async function`（手写形态）：第一个 await 必须是 requireAdmin；
 *   · `export const X = defineAction({...})`（M6.1 起的形态）：必须声明 `auth: { admin: "…" }`——defineAction 对这种声明保证
 *     requireAdmin 是第一个 await（先于读表单与取数，lib/actions/define-action.ts 的单测守护），所以声明本身就是鉴权。
 *     声明成 `"user"` / `"guest"` 或干脆漏写，都算违规。
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
  void file;
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
  return out;
}

/** 切出每个 `export const X = defineAction(…)` 的源码片段：key = 常量名 */
export function defineActionBodies(src: string): Map<string, string> {
  const text = stripComments(src);
  const out = new Map<string, string>();
  const next = [...text.matchAll(/\bexport\s/g)].map((m) => m.index!);
  for (const m of text.matchAll(/export\s+const\s+([\w$]+)\s*=\s*defineAction\s*\(/g)) {
    const end = next.find((n) => n > m.index! + 6) ?? text.length;
    out.set(m[1]!, text.slice(m.index!, end));
  }
  return out;
}

/** defineAction 片段是否声明了 admin 鉴权：`auth: { admin: "…" }` */
export const declaresAdminAuth = (body: string): boolean =>
  /\bauth\s*:\s*\{\s*admin\s*:/.test(body);

// 版主作用域入口豁免：review/actions 的鉴权是帖子版块的 forum.moderate（在 lib/moderation 服务内判定），
// 不持 site.admin 的版主也要能用——defineAction 声明 auth:"user" 是有意为之（M9 拍板，越权矩阵 E2E 覆盖）。
const MODERATOR_SCOPE_EXEMPT = new Set([
  "review/actions.ts",
  // 投票管理：关闭/删除的权限在服务层（site.admin 全站 / 版主所辖版块）——M10 补做，同 review 口径
  "poll/actions.ts",
]);

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

  it("每个入口的鉴权都在最前面：手写函数的第一个 await 是 requireAdmin；defineAction 声明了 auth: { admin }", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const fns = entryBodies(f.rel, f.src);
      const das = defineActionBodies(f.src);
      for (const [name, body] of fns) {
        // requireModerator 是版主可达页（review）的等价门禁（M9；未登录 redirect、无权限 404，同纪律）
        const first = firstAwaitedCall(body);
        // requireModerator：版主可达页（review）的等价门禁（未登录 redirect、无权限 404，同纪律）。
        // layout 等价门禁：首个 await 是 getCurrentUser 且函数体做 site.admin / 版主（getModeratedForumIds）判定。
        const layoutEquivalent =
          first === "getCurrentUser" &&
          /site\.admin/.test(body) &&
          /getModeratedForumIds/.test(body);
        if (first !== "requireAdmin" && first !== "requireModerator" && !layoutEquivalent)
          offenders.push(`${f.rel} › ${name}`);
      }
      for (const [name, body] of das) {
        if (!declaresAdminAuth(body))
          if (!MODERATOR_SCOPE_EXEMPT.has(f.rel)) {
            offenders.push(`${f.rel} › ${name}（defineAction 未声明 admin 鉴权）`);
          }
      }
      // 页面 / 布局 / actions 文件一个入口都找不到：多半是写法变了而守卫没跟上，宁可报错也不悄悄通过
      if (fns.size + das.size === 0) offenders.push(`${f.rel} › （没有识别到任何入口）`);
    }
    expect(offenders).toEqual([]);
  });

  it("actions.ts 里的入口不止一个（守卫确实逐个检查了每个动作）", () => {
    const actions = files.find((f) => f.rel === "actions.ts")!;
    expect(
      entryBodies(actions.rel, actions.src).size + defineActionBodies(actions.src).size,
    ).toBeGreaterThanOrEqual(4);
  });

  it("actions.ts 里不再有 `export async function`：入口统一走 defineAction（lib/actions/use-server-exports-guard 也会守护）", () => {
    const actions = files.find((f) => f.rel === "actions.ts")!;
    expect([...entryBodies(actions.rel, actions.src).keys()]).toEqual([]);
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

describe("defineActionBodies / declaresAdminAuth 自身", () => {
  const good = `export const a = defineAction({ name: "x", auth: { admin: "admin.roles" }, async run() {} });`;
  const user = `export const b = defineAction({ name: "x", auth: "user", async run() {} });`;
  const guest = `export const c = defineAction({ name: "x", auth: "guest", async run() {} });`;
  const missing = `export const d = defineAction({ name: "x", async run() {} });`;
  const inComment = `export const e = defineAction({ // auth: { admin: "admin.roles" }\n name: "x", auth: "user", async run() {} });`;

  it("声明 admin 鉴权的通过；user / guest / 漏写 / 只写在注释里的都识别为违规", () => {
    const das = defineActionBodies([good, user, guest, missing, inComment].join("\n"));
    expect([...das.keys()]).toEqual(["a", "b", "c", "d", "e"]);
    expect([...das].map(([n, b]) => [n, declaresAdminAuth(b)])).toEqual([
      ["a", true],
      ["b", false],
      ["c", false],
      ["d", false],
      ["e", false],
    ]);
  });

  it("多个 defineAction 互不串味：后一个声明的 admin 不能替前一个背书", () => {
    const das = defineActionBodies(`${user}\n${good}`);
    expect(declaresAdminAuth(das.get("b")!)).toBe(false);
    expect(declaresAdminAuth(das.get("a")!)).toBe(true);
  });
});
