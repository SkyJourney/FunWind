import { describe, expect, it } from "vitest";
import { affectedRowsOf, insertIdOf } from "./sql-result";

describe("insertIdOf", () => {
  it("接受 mysql2 / drizzle 的 result tuple，并返回有效自增 id", () => {
    expect(insertIdOf([{ insertId: 42 }])).toBe(42);
    expect(insertIdOf({ insertId: "7" })).toBe(7);
  });

  it("缺失、零、非安全整数或畸形结果一律显式失败", () => {
    for (const result of [
      null,
      {},
      [],
      [{ insertId: 0 }],
      [{ insertId: Number.NaN }],
      [{ insertId: Number.MAX_SAFE_INTEGER + 1 }],
    ]) {
      expect(() => insertIdOf(result)).toThrow(TypeError);
    }
  });

  it("affectedRowsOf：接受零行 UPDATE 与 mysql2 tuple，并验证返回值", () => {
    expect(affectedRowsOf([{ affectedRows: 0 }])).toBe(0);
    expect(affectedRowsOf({ affectedRows: "3" })).toBe(3);
    expect(() => affectedRowsOf({})).toThrow(TypeError);
    expect(() => affectedRowsOf({ affectedRows: -1 })).toThrow(TypeError);
  });
});
