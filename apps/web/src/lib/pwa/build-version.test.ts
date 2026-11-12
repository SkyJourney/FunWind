// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SW 版本号单测（M16.1 Step 4.5 补齐）：本文件在 Step 3 遗漏，而它落在覆盖率 include
 * （src/lib/**）分母内却零测试。更要紧的是「读不到 BUILD_ID 回落 dev」这条分支——
 * 静默回落会让所有部署共用 ?v=dev，浏览器不再重装 SW、离线壳永久停旧，
 * 正是版本化要消灭的故障模式，因此回落必须带可见告警。
 *
 * 模块级缓存：每例用 vi.resetModules() + 动态 import 取全新实例。
 */
const readFileSync = vi.hoisted(() => vi.fn());
vi.mock("node:fs", () => ({ readFileSync }));

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetModules();
  readFileSync.mockReset();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const load = async () => (await import("./build-version")).swVersion;

describe("swVersion", () => {
  it("读到 BUILD_ID：trim 后返回，并只读一次（模块级缓存）", async () => {
    readFileSync.mockReturnValue("  build-abc123\n");
    const swVersion = await load();
    expect(swVersion()).toBe("build-abc123");
    expect(swVersion()).toBe("build-abc123");
    expect(readFileSync).toHaveBeenCalledTimes(1);
  });

  it("按 NEXT_DIST_DIR 定位产物目录（与 next.config 的 distDir 同口径）", async () => {
    vi.stubEnv("NEXT_DIST_DIR", ".next-verify");
    readFileSync.mockReturnValue("x");
    const swVersion = await load();
    swVersion();
    expect(String(readFileSync.mock.calls[0]![0])).toContain(".next-verify");
  });

  it("读不到文件：回落 dev，并给出可见告警（不静默退化）", async () => {
    readFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const swVersion = await load();
    expect(swVersion()).toBe("dev");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("BUILD_ID");
  });

  it("文件为空：同样回落 dev 并告警（空版本号等于没有版本化）", async () => {
    readFileSync.mockReturnValue("   \n");
    const swVersion = await load();
    expect(swVersion()).toBe("dev");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("回落也缓存：不每次调用都重复读盘与刷告警", async () => {
    readFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const swVersion = await load();
    swVersion();
    swVersion();
    expect(readFileSync).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
