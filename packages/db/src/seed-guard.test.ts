import { describe, expect, it } from "vitest";
import { assessSeedTarget } from "./seed-guard.js";

describe("assessSeedTarget（纯判定）", () => {
  it("空库 / 纯演示库、非生产环境 → 放行", () => {
    expect(assessSeedTarget({ nodeEnv: undefined, foreignUsers: 0 }, false)).toEqual({
      ok: true,
      forced: false,
    });
    expect(assessSeedTarget({ nodeEnv: "development", foreignUsers: 0 }, false)).toEqual({
      ok: true,
      forced: false,
    });
    expect(assessSeedTarget({ nodeEnv: "test", foreignUsers: 0 }, false).ok).toBe(true);
  });

  it("NODE_ENV=production → 拒绝", () => {
    const v = assessSeedTarget({ nodeEnv: "production", foreignUsers: 0 }, false);
    expect(v).toEqual({ ok: false, reasons: ["NODE_ENV=production"] });
  });

  it("库里有非演示用户 → 拒绝，并说明数量", () => {
    const v = assessSeedTarget({ nodeEnv: undefined, foreignUsers: 3 }, false);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reasons[0]).toContain("3 个非演示用户");
  });

  it("两个原因同时成立 → 全部列出", () => {
    const v = assessSeedTarget({ nodeEnv: "production", foreignUsers: 1 }, false);
    expect(v.ok === false && v.reasons).toHaveLength(2);
  });

  it("--force 覆盖拒绝，并标记 forced（供调用方打印警告）", () => {
    expect(assessSeedTarget({ nodeEnv: "production", foreignUsers: 5 }, true)).toEqual({
      ok: true,
      forced: true,
    });
    // 本来就允许时 --force 不算「被覆盖」
    expect(assessSeedTarget({ nodeEnv: undefined, foreignUsers: 0 }, true)).toEqual({
      ok: true,
      forced: false,
    });
  });
});
