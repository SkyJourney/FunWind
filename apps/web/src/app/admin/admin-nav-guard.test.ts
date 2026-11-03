// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * G-07：后台菜单 need 必须与页面首个授权守卫一致。
 * 解析语法树，不依赖导航对象的缩进、换行与引号风格；未知 need 直接报错，不能静默漏扫。
 * 内容管理保留既有的多权限入口，但只认可完整作用域判定，不把单纯登录视为版主授权。
 */
const SRC = join(__dirname, "../..");
interface NavItem {
  href: string;
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
      out.push({ href: href.text, need: needOf(property(item, "need")) });
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

describe("后台菜单-守卫同源（G-07）", () => {
  const items = parseNavItems(readFileSync(join(SRC, "app/admin/layout.tsx"), "utf8"));

  it("解析全部导航项；每项都有对应页面且授权一致", () => {
    expect(items.length).toBeGreaterThanOrEqual(21);
    expect(items).toContainEqual({ href: "/admin/themes", need: "admin:site.admin" });
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

describe("导航守卫自身", () => {
  it("换行对象可解析，未知权限与动态对象不能漏扫", () => {
    const src =
      'const NAV_GROUPS = [{ label: "组", items: [{\n href: "/admin/mail",\n need: { admin: "admin.logs" },\n label: "邮件",\n}] }];';
    expect(parseNavItems(src)).toEqual([{ href: "/admin/mail", need: "admin:admin.logs" }]);
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
    expect(matches({ href: "/admin/mail", need: "admin:admin.logs" }, "admin:site.admin")).toBe(
      false,
    );
    expect(matches({ href: "/admin/other", need: "moderate:true" }, "contents-scope")).toBe(false);
  });
});
