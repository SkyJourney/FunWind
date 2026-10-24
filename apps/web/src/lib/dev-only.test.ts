import { describe, expect, it } from "vitest";
import { devOnlyResponse, isDevEnv } from "./dev-only";

describe("isDevEnv", () => {
  it("只有 NODE_ENV=production 才算生产；开发/测试/未设置都算开发环境", () => {
    expect(isDevEnv({ NODE_ENV: "production" })).toBe(false);
    expect(isDevEnv({ NODE_ENV: "development" })).toBe(true);
    expect(isDevEnv({ NODE_ENV: "test" })).toBe(true);
    expect(isDevEnv({})).toBe(true);
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
