import { beforeEach, describe, expect, it, vi } from "vitest";
import { emit, type EventLogRow } from "./bus.js";
import { registerModule, resetRegistryForTests } from "./registry.js";
import { defineModule } from "./types.js";

beforeEach(() => resetRegistryForTests());

function fakeWriter() {
  const rows: EventLogRow[] = [];
  return {
    rows,
    write: async (row: EventLogRow) => {
      rows.push(row);
    },
  };
}

describe("emit", () => {
  it("按注册序派发给启用模块", async () => {
    const calls: string[] = [];
    registerModule(
      defineModule({
        id: "m1",
        description: "",
        events: { "user.logged_in": () => void calls.push("m1") },
      }),
    );
    registerModule(
      defineModule({
        id: "m2",
        description: "",
        events: { "user.logged_in": () => void calls.push("m2") },
      }),
    );
    const w = fakeWriter();
    const r = await emit(
      "user.logged_in",
      { userId: 7 },
      { enabledModuleIds: new Set(["m1", "m2"]), writer: w.write },
    );
    expect(calls).toEqual(["m1", "m2"]);
    expect(r.dispatched.map((d) => d.moduleId)).toEqual(["m1", "m2"]);
    expect(r.errors).toEqual([]);
    expect(r.logged).toBe(true);
    expect(w.rows).toHaveLength(1);
    expect(w.rows[0].eventName).toBe("user.logged_in");
    expect(w.rows[0].actorId).toBe(7); // payload.userId 自动作为 actor
  });

  it("禁用模块不被派发", async () => {
    const calls: string[] = [];
    registerModule(
      defineModule({
        id: "on",
        description: "",
        events: { "user.logged_in": () => void calls.push("on") },
      }),
    );
    registerModule(
      defineModule({
        id: "off",
        description: "",
        events: { "user.logged_in": () => void calls.push("off") },
      }),
    );
    await emit(
      "user.logged_in",
      { userId: 1 },
      { enabledModuleIds: new Set(["on"]), writer: fakeWriter().write },
    );
    expect(calls).toEqual(["on"]);
  });

  it("消费者抛错被隔离：后续消费者照常、错误入审计", async () => {
    const calls: string[] = [];
    registerModule(
      defineModule({
        id: "boom",
        description: "",
        events: {
          "thread.created": () => {
            throw new Error("boom!");
          },
        },
      }),
    );
    registerModule(
      defineModule({
        id: "after",
        description: "",
        events: { "thread.created": () => void calls.push("after") },
      }),
    );
    const w = fakeWriter();
    const r = await emit(
      "thread.created",
      { threadId: 9, forumId: 1, authorId: 2 },
      { enabledModuleIds: new Set(["boom", "after"]), writer: w.write },
    );
    expect(calls).toEqual(["after"]); // 后续消费者未受影响
    expect(r.dispatched).toEqual([{ moduleId: "after" }]);
    expect(r.errors).toEqual([{ moduleId: "boom", message: "boom!" }]);
    expect(w.rows[0].errorJson).toBe(JSON.stringify([{ moduleId: "boom", message: "boom!" }]));
  });

  it("非 Error 抛出物也能被摘要", async () => {
    registerModule(
      defineModule({
        id: "throw-string",
        description: "",
        events: {
          "user.registered": () => {
            throw "字符串异常";
          },
        },
      }),
    );
    const w = fakeWriter();
    const r = await emit(
      "user.registered",
      { userId: 1 },
      { enabledModuleIds: new Set(["throw-string"]), writer: w.write },
    );
    expect(r.errors[0].message).toBe("字符串异常");
  });

  it("审计落库失败不反噬派发（logged=false 降级）", async () => {
    registerModule(
      defineModule({ id: "m", description: "", events: { "user.logged_in": () => {} } }),
    );
    const writer = vi.fn().mockRejectedValue(new Error("db down"));
    const r = await emit(
      "user.logged_in",
      { userId: 1 },
      { enabledModuleIds: new Set(["m"]), writer },
    );
    expect(r.dispatched).toEqual([{ moduleId: "m" }]);
    expect(r.logged).toBe(false);
  });

  it("无消费者时静默落审计", async () => {
    const w = fakeWriter();
    const r = await emit(
      "medal.awarded",
      { userId: 3, medalId: 9 },
      { enabledModuleIds: new Set(), writer: w.write },
    );
    expect(r.dispatched).toEqual([]);
    expect(r.logged).toBe(true);
    expect(w.rows).toHaveLength(1);
  });

  it("显式 actorId/source/now 透传审计行", async () => {
    const w = fakeWriter();
    const now = new Date("2026-10-23T12:00:00+08:00");
    await emit(
      "user.logged_in",
      { userId: 5 },
      { writer: w.write, actorId: 42, source: "dev-api", now },
    );
    expect(w.rows[0].actorId).toBe(42);
    expect(w.rows[0].source).toBe("dev-api");
    expect(w.rows[0].createdAt).toBe(now);
  });
});
