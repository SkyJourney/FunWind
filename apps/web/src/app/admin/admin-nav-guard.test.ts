// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { ICON_BY_HREF } from "@/components/admin/admin-nav-icons";

/**
 * G-07：后台菜单 need 必须与页面首个授权守卫一致。
 * 解析语法树，不依赖导航对象的缩进、换行与引号风格；未知 need 直接报错，不能静默漏扫。
 * 内容管理保留既有的多权限入口，但只认可完整作用域判定，不把单纯登录视为版主授权。
 * M19 追加三条 IA 断言：页面→菜单反向守卫（漏登记即红）、菜单 label 与页面 title 拉齐、
 * 图标全量覆盖（不允许回落图标出现在菜单上）——制度化堵住「加页面忘登记」。
 */
const SRC = join(__dirname, "../..");
interface NavItem {
  href: string;
  label: string;
  need: string;
}

function parse(src: string): ts.SourceFile {
  return ts.createSourceFile("page.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function property(node: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  const entry = node.properties.find(
    (p) => ts.isPropertyAssignment(p) && p.name.getText() === name,
  );
  return entry && ts.isPropertyAssignment(entry) ? entry.initializer : undefined;
}

function needOf(node: ts.Expression | undefined): string {
  if (!node || !ts.isObjectLiteralExpression(node) || node.properties.length !== 1) {
    throw new Error("导航 need 必须显式声明一种权限");
  }
  const admin = property(node, "admin");
  if (admin && ts.isStringLiteral(admin)) return `admin:${admin.text}`;
  if (property(node, "moderate")?.kind === ts.SyntaxKind.TrueKeyword) return "moderate:true";
  throw new Error("未知导航 need，须扩充守卫语义");
}

export function parseNavItems(src: string): NavItem[] {
  const source = parse(src);
  let groups: ts.ArrayLiteralExpression | undefined;
  function locate(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === "NAV_GROUPS" &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    )
      groups = node.initializer;
    ts.forEachChild(node, locate);
  }
  locate(source);
  if (!groups) throw new Error("未找到 NAV_GROUPS");
  const out: NavItem[] = [];
  for (const group of groups.elements) {
    if (!ts.isObjectLiteralExpression(group)) throw new Error("导航分组须为显式对象");
    const items = property(group, "items");
    if (!items || !ts.isArrayLiteralExpression(items)) throw new Error("分组缺少 items");
    for (const item of items.elements) {
      if (!ts.isObjectLiteralExpression(item)) throw new Error("导航项须为显式对象");
      const href = property(item, "href");
      if (!href || !ts.isStringLiteral(href)) throw new Error("导航 href 须为静态路径");
      const label = property(item, "label");
      if (!label || !ts.isStringLiteral(label)) throw new Error("导航 label 须为静态文案");
      out.push({ href: href.text, label: label.text, need: needOf(property(item, "need")) });
    }
  }
  return out;
}

export function pageGuard(src: string): string | null {
  const source = parse(src);
  const page = source.statements.find(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword),
  );
  if (!page || !ts.isFunctionDeclaration(page) || !page.body) return null;
  let first: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (first) return;
    if (node !== page && ts.isFunctionLike(node)) return;
    if (ts.isAwaitExpression(node)) {
      first = node.expression;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(page.body);
  if (!first || !ts.isCallExpression(first) || !ts.isIdentifier(first.expression)) return null;
  const name = first.expression.text;
  if (name === "requireModerator") return "moderate:true";
  if (name === "requireAdmin") {
    if (first.arguments.length === 0) return "admin:site.admin";
    const perm = first.arguments[0];
    return perm && ts.isStringLiteral(perm) && first.arguments.length === 1
      ? `admin:${perm.text}`
      : null;
  }
  if (name === "getCurrentUser") {
    const statements = page.body.statements.map((s) => s.getText(source).replace(/\s/g, ""));
    const hasScopeQuery = statements.some((s) =>
      s.includes(
        'const[isSiteAdmin,hasRecycle,moderated]=awaitPromise.all([checkPermission(subject,"site.admin"),checkPermission(subject,"admin.recycle"),getModeratedForumIds(subject),]);',
      ),
    );
    const hasRejection = statements.includes(
      "if(!isSiteAdmin.allowed&&!hasRecycle.allowed&&moderated.length===0)notFound();",
    );
    return hasScopeQuery && hasRejection ? "contents-scope" : null;
  }
  return null;
}

function matches(item: NavItem, guard: string | null): boolean {
  if (guard === "contents-scope")
    return item.href === "/admin/contents" && item.need === "moderate:true";
  return item.need === guard;
}

/** metadata.title 的字符串字面量（AST，与 NAV_GROUPS 解析同一手法；无 metadata 返回 null） */
function pageTitle(src: string): string | null {
  const source = parse(src);
  let title: string | null = null;
  function locate(node: ts.Node) {
    if (
      ts.isVariableStatement(node) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const decl of node.declarationList.declarations) {
        if (
          decl.name.getText(source) === "metadata" &&
          decl.initializer &&
          ts.isObjectLiteralExpression(decl.initializer)
        ) {
          const value = property(decl.initializer, "title");
          if (value && ts.isStringLiteral(value)) title = value.text;
        }
      }
    }
    ts.forEachChild(node, locate);
  }
  locate(source);
  return title;
}

/** /admin 下全部 page.tsx 路由（动态段保留原样，如 /admin/users/[uid]） */
function adminPageRoutes(): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), `${prefix}/${entry.name}`);
      } else if (entry.name === "page.tsx") {
        out.push(`/admin${prefix}`);
      }
    }
  };
  walk(join(SRC, "app/admin"), "");
  return out.sort();
}

/** 刻意的二级页：显式登记替代菜单项（decor 站长拍板 906dd710 不回菜单；mail/preview 属邮件页内跳转） */
const SECONDARY_PAGES = new Set(["/admin/decor", "/admin/mail/preview"]);
/** M19 合并/退役后的永久跳转兼容页（review、logo、hero） */
const REDIRECT_PAGES = new Set(["/admin/review", "/admin/logo", "/admin/hero"]);

describe("后台菜单-守卫同源（G-07）", () => {
  const items = parseNavItems(readFileSync(join(SRC, "app/admin/layout.tsx"), "utf8"));

  it("解析全部导航项；每项都有对应页面且授权一致", () => {
    expect(items.length).toBeGreaterThanOrEqual(21);
    expect(items).toContainEqual({
      href: "/admin/themes",
      label: "主题管理",
      need: "admin:site.admin",
    });
    const offenders = items.flatMap((item) => {
      const path = join(SRC, "app", item.href.slice(1), "page.tsx");
      if (!existsSync(path)) return [`${item.href}: 页面不存在`];
      const guard = pageGuard(readFileSync(path, "utf8"));
      return matches(item, guard) ? [] : [`${item.href}: need=${item.need}，守卫=${guard}`];
    });
    expect(offenders).toEqual([]);
  });

  it("后台首页允许版主，与可见的管理入口相符", () => {
    expect(pageGuard(readFileSync(join(SRC, "app/admin/page.tsx"), "utf8"))).toBe("moderate:true");
  });

  it("站点菜单叠加 site.admin 总门，与 requireAdmin 的组合权限一致", () => {
    const layout = readFileSync(join(SRC, "app/admin/layout.tsx"), "utf8");
    expect(layout).toMatch(
      /if\s*\("admin"\s+in\s+entry.need\)\s*\{\s*if\s*\(!siteAdmin.allowed\)\s*return null/,
    );
  });
});

describe("菜单 IA 完备性（M19）", () => {
  const items = parseNavItems(readFileSync(join(SRC, "app/admin/layout.tsx"), "utf8"));
  const routes = adminPageRoutes();

  it("反向守卫：每个 admin 页面要么在菜单登记（自身或菜单项前缀下），要么显式在允许清单", () => {
    const offenders = routes.flatMap((route) => {
      if (route === "/admin") return []; // 首页是按权限跳转的落点，另有单独断言
      if (SECONDARY_PAGES.has(route) || REDIRECT_PAGES.has(route)) return [];
      const registered =
        items.some((item) => item.href === route) ||
        items.some((item) => route.startsWith(`${item.href}/`));
      return registered ? [] : [`${route}: 未登记菜单且不在允许清单（漏登记防漂移）`];
    });
    expect(offenders).toEqual([]);
  });

  it("菜单 label 与页面 metadata.title 逐字一致（title 以菜单短名为准）", () => {
    const offenders = items.flatMap((item) => {
      const path = join(SRC, "app", item.href.slice(1), "page.tsx");
      const title = pageTitle(readFileSync(path, "utf8"));
      return title === item.label ? [] : [`${item.href}: label=${item.label}，title=${title}`];
    });
    expect(offenders).toEqual([]);
  });

  it("图标覆盖：每个菜单项都有专属图标（不允许回落图标出现在菜单上）", () => {
    const missing = items.filter((item) => !ICON_BY_HREF[item.href]).map((item) => item.href);
    expect(missing).toEqual([]);
  });

  it("反向守卫自检：未登记路由与跳转页豁免的判定符合预期", () => {
    const registered = (route: string) =>
      route === "/admin" ||
      SECONDARY_PAGES.has(route) ||
      REDIRECT_PAGES.has(route) ||
      items.some((item) => item.href === route) ||
      items.some((item) => route.startsWith(`${item.href}/`));
    expect(registered("/admin/users/[uid]")).toBe(true); // 菜单前缀覆盖
    expect(registered("/admin/decor")).toBe(true); // 二级页清单
    expect(registered("/admin/review")).toBe(true); // 跳转页清单
    expect(registered("/admin/unknown")).toBe(false);
  });
});

describe("导航守卫自身", () => {
  it("换行对象可解析，未知权限与动态对象不能漏扫", () => {
    const src =
      'const NAV_GROUPS = [{ label: "组", items: [{\n href: "/admin/mail",\n need: { admin: "admin.logs" },\n label: "邮件",\n}] }];';
    expect(parseNavItems(src)).toEqual([
      { href: "/admin/mail", label: "邮件", need: "admin:admin.logs" },
    ]);
    expect(() =>
      parseNavItems('const NAV_GROUPS = [{items:[{href:"/admin/x",need:{other:true}}]}];'),
    ).toThrow();
  });

  it("只登录不足以通过版主检查，注释里的守卫不算数", () => {
    expect(pageGuard("export default async function Page(){await getCurrentUser();}")).toBeNull();
    expect(
      pageGuard(
        "export default async function Page(){// await requireAdmin();\n await requireModerator();}",
      ),
    ).toBe("moderate:true");
    expect(
      matches({ href: "/admin/mail", label: "邮件", need: "admin:admin.logs" }, "admin:site.admin"),
    ).toBe(false);
    expect(
      matches({ href: "/admin/other", label: "其他", need: "moderate:true" }, "contents-scope"),
    ).toBe(false);
  });
});
