// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MANAGE_ENDPOINTS } from "@/lib/manage/permissions";

const contract = resolve(import.meta.dirname, "../../../../../../docs/MANAGE-API.md");

describe("管理 REST 仓库契约", () => {
  it("端点清单与权限目录的实际方法、路径和域档位一一对应", () => {
    const markdown = readFileSync(contract, "utf8");
    const catalog = markdown.split(/^## 端点清单\s*$/m)[1]?.split(/^## /m)[0];
    expect(catalog, "仓库契约必须有端点清单").toBeDefined();
    const rows = [
      ...(catalog ?? "").matchAll(
        /^\|\s*`([A-Z]+)`\s*\|\s*`(\/api\/manage\/[^`]+)`\s*\|\s*`([a-z-]+:(?:read|write))`\s*\|/gm,
      ),
    ];
    const actual = rows.map(([, method, path, scope]) => `${method} ${path} ${scope}`);
    const expected = Object.values(MANAGE_ENDPOINTS).map(
      ({ method, path, domain, access }) => `${method} ${path} ${domain}:${access}`,
    );
    expect(actual.sort()).toEqual(expected.sort());
  });
});
