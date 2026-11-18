import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { LEGACY_M20_ENDPOINTS, MANAGE_ENDPOINTS } from "@/lib/manage/permissions";

/**
 * manage-api 分层守卫（M20 文档 §2 硬规则 1）：
 * route.ts = 入口封装（鉴权 + 参数解析 + 调 Service + 信封），
 * 业务查询/写逻辑只允许出现在 lib 层 Service。静态扫描固化。
 */

function collectManageRoutes(): string[] {
  const root = join(import.meta.dirname);
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (/^route\.([cm]?[jt]s|[jt]sx)$/.test(entry)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/** 从直接的 HTTP 方法导出提取端点绑定，不接受别名、二次包装或无门禁的入口。 */
function readEndpointBindings(file: string) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const bindings: { method: string; endpoint: string }[] = [];
  for (const node of source.statements) {
    expect(ts.isExportDeclaration(node) || ts.isExportAssignment(node), file).toBe(false);
    if (!ts.canHaveModifiers(node)) continue;
    if (!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    expect(ts.isVariableStatement(node), file).toBe(true);
    if (!ts.isVariableStatement(node)) continue;
    for (const { name, initializer } of node.declarationList.declarations) {
      const method = name.getText(source);
      if (method === "dynamic") continue;
      expect(HTTP_METHODS.has(method), `${file} ${method}`).toBe(true);
      if (!initializer || !ts.isCallExpression(initializer)) {
        throw new Error(`${file} ${method} 未直接使用管理 REST 入口封装`);
      }
      const factory = initializer.expression.getText(source);
      expect(["manageEndpoint", "manageLogEndpoint"], file).toContain(factory);
      const options = initializer.arguments[factory === "manageLogEndpoint" ? 0 : 1];
      if (!options || !ts.isObjectLiteralExpression(options)) {
        throw new Error(`${file} ${method} 未声明端点绑定`);
      }
      const ids = options.properties.filter((prop) => prop.name?.getText(source) === "endpoint");
      const id = ids[0];
      if (
        ids.length !== 1 ||
        !id ||
        !ts.isPropertyAssignment(id) ||
        !ts.isStringLiteral(id.initializer)
      ) {
        throw new Error(`${file} ${method} 必须绑定一个字面量端点 ID`);
      }
      bindings.push({ method, endpoint: id.initializer.text });
    }
  }
  return bindings;
}

describe("manage-api 分层与端点绑定守卫", () => {
  const routes = collectManageRoutes();

  it("历史快照固定为原九个 GET 的 ID 与路径，不能随新业务扩张", () => {
    const legacy = LEGACY_M20_ENDPOINTS.map((id) => {
      const { method, path, access } = MANAGE_ENDPOINTS[id];
      expect(access).toBe("read");
      return `${method} ${path} ${id}`;
    });
    expect(legacy.sort()).toEqual([
      "GET /api/manage/audit-logs audit-logs",
      "GET /api/manage/contents contents",
      "GET /api/manage/contents/{id} contents.detail",
      "GET /api/manage/emails emails",
      "GET /api/manage/push-logs push-logs",
      "GET /api/manage/stats stats",
      "GET /api/manage/users users",
      "GET /api/manage/users/{uid} users.detail",
      "GET /api/manage/whoami whoami",
    ]);
  });

  it("route.ts 禁止业务 import（@funwind/db / drizzle-orm）与 drizzle 调用链", () => {
    for (const file of routes) {
      const src = readFileSync(file, "utf8");
      expect(src, `${file} 不得 import @funwind/db（业务查询在 Service 层）`).not.toMatch(
        /from "@funwind\/db"/,
      );
      expect(src, `${file} 不得 import drizzle-orm（评估器/查询都在 Service 层）`).not.toMatch(
        /from "drizzle-orm"/,
      );
      expect(src, `${file} 不得出现 drizzle 查询链`).not.toMatch(
        /\.select\(|\.insert\(|\.update\(|\.delete\(/,
      );
    }
  });

  it("每个 HTTP 方法与目录的路径、方法、权限 ID 一一对应且 force-dynamic", () => {
    const prefix = import.meta.dirname;
    const observed = routes.flatMap((file) => {
      expect(readFileSync(file, "utf8"), file).toMatch(/export const dynamic = "force-dynamic"/);
      const segments = relative(prefix, file).split(sep).slice(0, -1);
      const path = `/api/manage/${segments.join("/").replace(/\[([^\]]+)\]/g, "{$1}")}`;
      return readEndpointBindings(file).map(
        ({ method, endpoint }) => `${method} ${path} ${endpoint}`,
      );
    });
    const expected = Object.entries(MANAGE_ENDPOINTS).map(
      ([id, { method, path }]) => `${method} ${path} ${id}`,
    );
    expect(observed.sort()).toEqual(expected.sort());
  });
});
