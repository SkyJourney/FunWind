// @vitest-environment node
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { type MotionPageDeclaration } from "@/lib/motion";
import { kindBetween } from "@/lib/motion/nav-kind";
import { isMotionPilot, siteMotionDirection, siteMotionRegistry } from "./motion-routes";

const APP = join(import.meta.dirname, "../../app");
const PARAM_SAMPLES: Readonly<Record<string, string>> = {
  pid: "101",
  tid: "201",
  uid: "301",
  fid: "401",
  convId: "501",
  roleKey: "moderator",
  token: "a".repeat(64),
};
const TAB_PATHS = [
  "/",
  "/boards",
  "/follows",
  "/search",
  "/submit",
  "/messages",
  "/notifications",
  "/me",
  "/login",
] as const;
const SUFFIXES = ["", "?page=2", "#p101", "?page=3&sort=latest#p102"] as const;

/** 递归收集全部页面，不以动效登记情况筛选，新增页面会自动进入双向矩阵。 */
function scanPages(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return scanPages(path);
    return entry.isFile() && entry.name === "page.tsx" ? [path] : [];
  });
}

/** 去掉每一层路由组，再按参数名及实体上下文填值；不认识的约定必须显式失败。 */
function pagePathname(file: string): string {
  const segments = file.split("/");
  if (segments.pop() !== "page.tsx") throw new Error(`不是页面文件：${file}`);
  const route = segments.filter((segment) => !/^\([^()]+\)$/.test(segment));
  return `/${route
    .map((segment, index) => {
      if (segment.includes("...")) throw new Error(`未支持的 catch-all 路由：${file}`);
      const parameter = /^\[([^\[\]]+)\]$/.exec(segment)?.[1];
      if (parameter === "id") {
        const context = route.slice(0, index).join("/");
        if (context === "a") return "601";
        if (context === "admin/themes") return "default";
        throw new Error(`未识别的 id 上下文：${file}`);
      }
      if (parameter !== undefined) {
        if (Object.hasOwn(PARAM_SAMPLES, parameter)) return PARAM_SAMPLES[parameter];
        throw new Error(`未识别的动态参数 ${parameter}：${file}`);
      }
      if (/[\[\]()]/.test(segment) || segment.startsWith("@") || segment.startsWith("_"))
        throw new Error(`未支持的路由段 ${segment}：${file}`);
      return segment;
    })
    .join("/")}`;
}

const pageFiles = scanPages(APP)
  .map((file) => relative(APP, file).split(sep).join("/"))
  .sort();
const pageSamples = pageFiles.map((file) => ({ file, path: pagePathname(file) }));
const labPages = pageSamples.filter(
  ({ path }) => path === "/motion-lab" || path.startsWith("/motion-lab/"),
);
const businessPages = pageSamples.filter((page) => !labPages.includes(page));
const additionalPaths = [
  "/t/202",
  "/a/602",
  "/admin/themes/custom-theme",
  "/unknown-motion-route",
  "/unknown-motion-route/child",
  "/t",
  "/a/601/extra",
  "/boards-extra",
  "/messages-extra/501",
];
const matrixSamples = [
  ...pageSamples,
  ...additionalPaths.map((path) => ({ file: "补充样本", path })),
];

/** 旧判定只接受 pathname，不能把新入口的查询串与 hash 直接传给旧判定。 */
function legacyPathname(path: string): string {
  return new URL(path, "https://motion.test").pathname;
}

function assertLegacyDirection(from: string, to: string): void {
  expect(siteMotionDirection(from, to), `${from} → ${to}`).toBe(
    kindBetween(legacyPathname(from), legacyPathname(to)),
  );
}

describe("页面扫描与样本生成自身", () => {
  it(`当前业务 ${businessPages.length} 页与 motion-lab ${labPages.length} 页分别统计，全部参与矩阵`, () => {
    // 下限守住当前基线，但不把未来新增页面排除在矩阵之外。
    expect(businessPages.length).toBeGreaterThanOrEqual(73);
    expect(labPages.length).toBeGreaterThanOrEqual(5);
    expect(businessPages.length + labPages.length).toBe(pageFiles.length);
    expect(pageSamples).toHaveLength(pageFiles.length);
    expect(new Set(pageSamples.map(({ path }) => path)).size).toBe(pageFiles.length);
    expect(new Set(matrixSamples.map(({ path }) => path)).size).toBe(matrixSamples.length);
    expect(matrixSamples.slice(0, pageSamples.length)).toEqual(pageSamples);
    expect(pageSamples.every(({ path }) => !/[\[\]()]/.test(path))).toBe(true);
    expect(labPages.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        "/motion-lab",
        "/motion-lab/back",
        "/motion-lab/one",
        "/motion-lab/stream",
        "/motion-lab/two",
      ]),
    );
    for (const path of TAB_PATHS)
      expect(
        pageSamples.some((page) => page.path === path),
        path,
      ).toBe(true);
  });

  it.each([
    ["page.tsx", "/"],
    ["(outer)/(inner)/page.tsx", "/"],
    ["(auth)/login/page.tsx", "/login"],
    ["(module-points)/points/page.tsx", "/points"],
    ["p/[pid]/edit/page.tsx", "/p/101/edit"],
    ["t/[tid]/page.tsx", "/t/201"],
    ["u/[uid]/page.tsx", "/u/301"],
    ["f/[fid]/new/page.tsx", "/f/401/new"],
    ["messages/[convId]/page.tsx", "/messages/501"],
    ["admin/authz/[roleKey]/page.tsx", "/admin/authz/moderator"],
    ["(auth)/reset/[token]/page.tsx", `/reset/${PARAM_SAMPLES.token}`],
    ["(outer)/a/(inner)/[id]/page.tsx", "/a/601"],
    ["(outer)/admin/(inner)/themes/(editor)/[id]/page.tsx", "/admin/themes/default"],
    ["(outer)/f/(middle)/[fid]/(inner)/new/page.tsx", "/f/401/new"],
  ])("%s 完整去组并生成 %s", (file, expected) => {
    expect(pagePathname(file)).toBe(expected);
  });

  it.each([
    ["t/[slug]/page.tsx", "未识别的动态参数"],
    ["t/[toString]/page.tsx", "未识别的动态参数"],
    ["admin/other/[id]/page.tsx", "未识别的 id 上下文"],
    ["t/[...tid]/page.tsx", "未支持的 catch-all"],
    ["t/[[...tid]]/page.tsx", "未支持的 catch-all"],
    ["@modal/t/[tid]/page.tsx", "未支持的路由段"],
    ["(.)t/[tid]/page.tsx", "未支持的路由段"],
  ])("%s 不能被静默跳过或套用错误参数", (file, message) => {
    expect(() => pagePathname(file)).toThrow(message);
  });
});

describe(`新旧方向全有向矩阵：${matrixSamples.length} 个样本，${matrixSamples.length ** 2} 个 from/to 对`, () => {
  it.each(matrixSamples)("起点 $path（$file），覆盖所有终点与自身", ({ path: from }) => {
    for (const { path: to } of matrixSamples) assertLegacyDirection(from, to);
  });

  it.each(matrixSamples)(
    "起点 $path，查询串和 hash 不改变任意终点的方向或声明",
    ({ path: from }) => {
      for (const suffix of SUFFIXES) {
        expect(siteMotionRegistry.resolve(`${from}${suffix}`), `${from}${suffix}`).toEqual(
          siteMotionRegistry.resolve(from),
        );
        for (const { path: to } of matrixSamples) {
          assertLegacyDirection(`${from}${suffix}`, to);
          assertLegacyDirection(from, `${to}${suffix}`);
          assertLegacyDirection(`${from}${suffix}`, `${to}${suffix}`);
        }
      }
    },
  );
});

describe("站点动效声明与匹配优先级", () => {
  it.each(TAB_PATHS.map((path, tabOrder) => ({ path, tabOrder })))(
    "Tab 根 $path 精确声明顺序 $tabOrder，具体规则不被分组默认遮住",
    ({ path, tabOrder }) => {
      expect(siteMotionRegistry.resolve(path)).toEqual({
        preset: path === "/login" ? "form" : "list",
        tabOrder,
        ...(path === "/login" ? {} : { level: path === "/" ? 0 : 1 }),
      });
      for (const [toOrder, to] of TAB_PATHS.entries()) {
        const expected =
          tabOrder === toOrder ? "fade" : toOrder > tabOrder ? "tab-next" : "tab-prev";
        expect(siteMotionDirection(path, to), `${path} → ${to}`).toBe(expected);
        expect(kindBetween(path, to), `${path} → ${to}`).toBe(expected);
      }
    },
  );

  it.each<{ path: string; page: MotionPageDeclaration }>([
    { path: "/f/401", page: { preset: "list", level: 2 } },
    { path: "/u/301", page: { preset: "list", level: 2 } },
    { path: "/f/401/new", page: { preset: "form", level: 3 } },
    { path: "/u/301/edit", page: { preset: "form", level: 3 } },
    { path: "/t/201", page: { preset: "detail", level: 3 } },
    { path: "/t/202", page: { preset: "detail", level: 3 } },
    { path: "/a", page: { preset: "list", level: 1 } },
    { path: "/a/601", page: { preset: "detail", level: 2 } },
    { path: "/a/602", page: { preset: "detail", level: 2 } },
    { path: "/points", page: { preset: "list", level: 1 } },
    { path: "/settings", page: { preset: "list", level: 1 } },
    { path: "/settings/profile", page: { preset: "list", level: 2 } },
    { path: "/messages/501", page: { preset: "list", level: 2 } },
    { path: "/admin", page: { preset: "list", level: 1 } },
    { path: "/admin/themes/default", page: { preset: "list", level: 2 } },
    { path: "/admin/authz/forum/401", page: { preset: "list", level: 2 } },
  ])("$path 的预设、层级及非 Tab 身份完整匹配", ({ path, page }) => {
    expect(siteMotionRegistry.resolve(path)).toEqual(page);
  });

  it.each([
    ...labPages.map(({ path }) => path),
    "/unknown-motion-route",
    "/unknown-motion-route/child",
    "/t",
    "/a/601/extra",
    "/boards-extra",
    "/messages-extra/501",
    "/forgot",
    "/register",
    "/p/101/edit",
  ])("未登记路径 %s 不被根或前缀规则误认，来回均保留旧 fade", (path) => {
    expect(siteMotionRegistry.resolve(path)).toBeUndefined();
    for (const other of ["/", "/login", "/t/201", "/a/601"]) {
      expect(siteMotionDirection(path, other)).toBe("fade");
      expect(siteMotionDirection(other, path)).toBe("fade");
    }
  });

  it.each([
    ["/f/401", "/f/401/new", "push"],
    ["/f/401/new", "/f/401", "pop"],
    ["/messages", "/messages/501", "push"],
    ["/messages/501", "/messages", "pop"],
    ["/a", "/a/601", "push"],
    ["/a/601", "/a", "pop"],
    ["/t/201", "/t/202", "fade"],
    ["/t/202", "/t/201", "fade"],
    ["/a/601", "/a/602", "fade"],
    ["/a/602", "/a/601", "fade"],
    ["/points", "/settings", "fade"],
    ["/admin", "/points", "fade"],
    ["/login", "/t/201", "fade"],
  ])("%s → %s 不误用 Tab 方向，保持 %s", (from, to, expected) => {
    expect(siteMotionDirection(from, to)).toBe(expected);
    expect(kindBetween(from, to)).toBe(expected);
  });
});

describe("M15 Step 2 试点边界", () => {
  it("真实页面中仅主题详情、公告归档与公告详情参与试点，实验页面不混入", () => {
    expect(pageSamples.filter(({ path }) => isMotionPilot(path)).map(({ path }) => path)).toEqual([
      "/a/601",
      "/a",
      "/t/201",
    ]);
    for (const { path } of labPages) expect(isMotionPilot(path), path).toBe(false);
  });

  it.each(["/t/201", "/t/202", "/a", "/a/601", "/a/602"])(
    "%s 在查询串和 hash 变化时仍是试点",
    (path) => {
      for (const suffix of SUFFIXES) expect(isMotionPilot(`${path}${suffix}`)).toBe(true);
    },
  );

  it.each([
    "/",
    "/t",
    "/t/",
    "/thread/201",
    "/t-extra/201",
    "/a/",
    "/a/601/extra",
    "/a-extra",
    "/admin/announcements",
    "/admin/themes/default",
    "/f/401",
    "/u/301",
    "/p/101/edit",
    "/unknown-motion-route",
  ])("%s 不扩大灰度试点，查询串与 hash 也不能伪装路径", (path) => {
    for (const suffix of [...SUFFIXES, "?next=/t/201", "#next=/a/601"])
      expect(isMotionPilot(`${path}${suffix}`), `${path}${suffix}`).toBe(false);
  });
});
