import { describe, expect, it, vi } from "vitest";
import { resolveEnablement, type EnablementMemory } from "./state";

/** 启用状态的降级策略（复查 B3）：读库失败时不能把停用的模块重新打开 */
const IDS = ["a", "b", "c"];
const fresh = (): EnablementMemory => ({ overrides: null });
const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});

describe("resolveEnablement", () => {
  it("正常读取：没有行 = 默认启用；有行按行", async () => {
    const r = await resolveEnablement(
      IDS,
      async () => [{ moduleId: "b", enabled: false }],
      fresh(),
    );
    expect([...r.enabledIds].sort()).toEqual(["a", "c"]);
    expect([...r.disabledIds]).toEqual(["b"]);
  });

  it("读取失败但有上一次成功的结果：沿用，停用的模块仍然停用", async () => {
    const spy = quiet();
    const memory = fresh();
    await resolveEnablement(IDS, async () => [{ moduleId: "b", enabled: false }], memory);
    const r = await resolveEnablement(
      IDS,
      async () => {
        throw new Error("连接池耗尽");
      },
      memory,
    );
    expect([...r.enabledIds].sort()).toEqual(["a", "c"]);
    expect([...r.disabledIds]).toEqual(["b"]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("冷启动就读不到：全部视为停用（fail-closed），而不是全部启用", async () => {
    const spy = quiet();
    const r = await resolveEnablement(
      IDS,
      async () => {
        throw new Error("数据库不可达");
      },
      fresh(),
    );
    expect(r.enabledIds.size).toBe(0);
    expect([...r.disabledIds].sort()).toEqual(IDS);
    spy.mockRestore();
  });

  it("恢复后立即回到真实状态；沿用期间新注册的模块按默认启用", async () => {
    const spy = quiet();
    const memory = fresh();
    await resolveEnablement(["a"], async () => [{ moduleId: "a", enabled: false }], memory);
    // 读取失败，且此时多了一个新模块 n（上次没见过）→ 沿用 a=停用，n 无覆盖记录按默认启用
    const during = await resolveEnablement(
      ["a", "n"],
      async () => {
        throw new Error("x");
      },
      memory,
    );
    expect([...during.disabledIds]).toEqual(["a"]);
    expect([...during.enabledIds]).toEqual(["n"]);
    const after = await resolveEnablement(["a", "n"], async () => [], memory);
    expect([...after.enabledIds].sort()).toEqual(["a", "n"]);
    spy.mockRestore();
  });
});
