import { describe, expect, it } from "vitest";
import { assertE2eResetTarget, E2E_DATABASE_NAME } from "./e2e-safety";

describe("E2E 数据库重置安全校验", () => {
  it("只允许专用 E2E 库连接本机 MySQL", () => {
    expect(() => assertE2eResetTarget(E2E_DATABASE_NAME, "127.0.0.1")).not.toThrow();
    expect(() => assertE2eResetTarget(E2E_DATABASE_NAME, "localhost")).not.toThrow();
    expect(() => assertE2eResetTarget(E2E_DATABASE_NAME, "::1")).not.toThrow();
  });

  it("拒绝默认应用库和其他数据库", () => {
    expect(() => assertE2eResetTarget("qysub_next", "127.0.0.1")).toThrow(/只允许目标数据库/);
    expect(() => assertE2eResetTarget("production", "127.0.0.1")).toThrow(/只允许目标数据库/);
  });

  it("拒绝非本机数据库主机", () => {
    expect(() => assertE2eResetTarget(E2E_DATABASE_NAME, "db.example.com")).toThrow(
      /只允许连接本机 MySQL/,
    );
  });
});
