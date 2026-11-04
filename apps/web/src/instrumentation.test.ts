// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/** instrumentation.register()：只在 Node 运行时、且只调用一次启动函数；Edge 运行时不得加载调度器 */

const start = vi.fn();
vi.mock("@/lib/scheduler", () => ({ startScheduler: start }));

import { register } from "./instrumentation";

beforeEach(() => {
  start.mockClear();
  vi.unstubAllEnvs();
});

describe("register", () => {
  it("nodejs 运行时：调用一次 startScheduler", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    await register();
    expect(start).toHaveBeenCalledOnce();
  });

  it.each(["edge", "", undefined])("运行时为 %j：不加载也不启动调度器", async (runtime) => {
    if (runtime === undefined) vi.stubEnv("NEXT_RUNTIME", undefined as unknown as string);
    else vi.stubEnv("NEXT_RUNTIME", runtime);
    await register();
    expect(start).not.toHaveBeenCalled();
  });

  it("register 在启动函数返回后立即完成（只登记，不等待任务运行）", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    start.mockReturnValue(undefined);
    await expect(register()).resolves.toBeUndefined();
  });
});
