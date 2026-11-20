// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MANAGE_ENDPOINTS } from "@/lib/manage/permissions";
import { DOCS_SECTIONS } from "@/lib/manage/api-docs-md";

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

  it("在线错误表不把运维触发列为幂等写，也不把空积分台账列为 404", () => {
    const errors = (slug: string) =>
      DOCS_SECTIONS.find((section) => section.slug === slug)
        ?.md.split("**错误**")
        .at(-1);
    expect(errors("ep-ops-trigger")).toContain("`ops_unavailable`（503）");
    expect(errors("ep-ops-trigger")).not.toContain("idempotency_conflict");
    expect(errors("ep-points-ledger")).toContain("`bad_request`（400）");
    expect(errors("ep-points-ledger")).not.toContain("not_found");
    expect(errors("ep-themes-edit")).toContain("`idempotency_conflict`（409）");
  });
});
