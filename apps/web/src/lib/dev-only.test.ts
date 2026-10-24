import { describe, expect, it } from "vitest";
import { devOnlyResponse, isDevEnv } from "./dev-only";

describe("isDevEnv（fail-closed：只有明确是开发 / 测试才放行）", () => {
  it("development / test 放行", () => {
    expect(isDevEnv({ NODE_ENV: "development" })).toBe(true);
    expect(isDevEnv({ NODE_ENV: "test" })).toBe(true);
  });

  it("production 与一切未知取值都不放行——变量缺失、空串、拼写错误（prod / Production / staging）不会把开发入口暴露到线上", () => {
    for (const v of [
      "production",
      "prod",
      "Production",
      "PRODUCTION",
      "staging",
      "dev",
      "",
      " development",
      undefined,
    ]) {
      expect(isDevEnv({ NODE_ENV: v }), `NODE_ENV=${JSON.stringify(v)}`).toBe(false);
    }
    expect(isDevEnv({})).toBe(false);
  });
});

describe("devOnlyResponse", () => {
  it("开发环境放行（null）；生产环境返回 404 JSON", async () => {
    const prev = process.env.NODE_ENV;
    try {
      (process.env as Record<string, string>).NODE_ENV = "development";
      expect(devOnlyResponse()).toBeNull();
      (process.env as Record<string, string>).NODE_ENV = "production";
      const res = devOnlyResponse();
      expect(res?.status).toBe(404);
      expect(await res?.json()).toEqual({ error: "not found" });
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = prev;
    }
  });
});
