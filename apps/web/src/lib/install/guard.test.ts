import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ installed: false, notFoundCalls: 0 }));

vi.mock("next/navigation", () => ({
  notFound: () => {
    state.notFoundCalls += 1;
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("./lock", () => ({ isInstalled: async () => state.installed }));

import { requireNotInstalled } from "./guard";

beforeEach(() => {
  state.installed = false;
  state.notFoundCalls = 0;
});

describe("install 入口守卫（M12 D2：lock 后 404）", () => {
  it("未安装：放行（不触发 notFound）", async () => {
    await expect(requireNotInstalled()).resolves.toBeUndefined();
    expect(state.notFoundCalls).toBe(0);
  });

  it("已安装：notFound（404 语义），调用方表现为 NOT_FOUND", async () => {
    state.installed = true;
    await expect(requireNotInstalled()).rejects.toThrow("NOT_FOUND");
    expect(state.notFoundCalls).toBe(1);
  });
});
