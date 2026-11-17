import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
      } else if (/^route\.(ts|mts)$/.test(entry)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

describe("manage-api 分层守卫（M20）", () => {
  const routes = collectManageRoutes();

  it("v1 九个端点全部在位", () => {
    const relatives = routes.map((f) => f.slice(f.indexOf("api/manage"))).sort();
    expect(relatives).toEqual(
      [
        "api/manage/audit-logs/route.ts",
        "api/manage/contents/[id]/route.ts",
        "api/manage/contents/route.ts",
        "api/manage/emails/route.ts",
        "api/manage/push-logs/route.ts",
        "api/manage/stats/route.ts",
        "api/manage/users/[uid]/route.ts",
        "api/manage/users/route.ts",
        "api/manage/whoami/route.ts",
      ].sort(),
    );
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

  it("每个端点都经入口封装（manageEndpoint / 日志类 manageLogEndpoint 工厂）且 force-dynamic", () => {
    for (const file of routes) {
      const src = readFileSync(file, "utf8");
      expect(src, file).toMatch(/manage(Log)?Endpoint\(/);
      expect(src, file).toMatch(/export const dynamic = "force-dynamic"/);
    }
  });
});
