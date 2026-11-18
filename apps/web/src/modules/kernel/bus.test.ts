import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emit, type EventLogRow } from "./bus";
import { registerModule, resetRegistryForTests } from "./registry";
import { defineModule } from "./types";

beforeEach(() => resetRegistryForTests());
afterEach(() => vi.restoreAllMocks());

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
            throw new Error("synthetic_consumer_message", {
              cause: { sql: "synthetic_consumer_sql" },
            });
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
      { threadId: 9, postId: 90, forumId: 1, authorId: 2, title: "t" },
      { enabledModuleIds: new Set(["boom", "after"]), writer: w.write },
    );
    expect(calls).toEqual(["after"]); // 后续消费者未受影响
    expect(r.dispatched).toEqual([{ moduleId: "after" }]);
    const summary = [{ moduleId: "boom", message: "consumer_failed" }];
    expect(r.errors).toEqual(summary);
    expect(w.rows[0].errorJson).toBe(JSON.stringify(summary));
    expect(w.rows[0].errorJson).not.toContain("synthetic_consumer_");
    expect(w.rows[0].actorId).toBe(2); // actor 按事件映射：thread.created → authorId
  });

  it("actor 按事件映射：thread.deleted → operatorId", async () => {
    const w = fakeWriter();
    await emit(
      "thread.deleted",
      { threadId: 1, postId: 10, forumId: 1, authorId: 3, operatorId: 66, byModerator: true },
      {
        enabledModuleIds: new Set(),
        writer: w.write,
      },
    );
    expect(w.rows[0].actorId).toBe(66);
  });

  it("非 Error 抛出物也能被摘要", async () => {
    registerModule(
      defineModule({
        id: "throw-string",
        description: "",
        events: {
          "user.registered": () => {
            throw "synthetic_thrown_string";
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
    expect(r.errors).toEqual([{ moduleId: "throw-string", message: "consumer_failed" }]);
    expect(w.rows[0].errorJson).toBe(JSON.stringify(r.errors));
    expect(w.rows[0].errorJson).not.toContain("synthetic_thrown_string");
  });

  it("审计落库失败不反噬派发（logged=false 降级）", async () => {
    registerModule(
      defineModule({ id: "m", description: "", events: { "user.logged_in": () => {} } }),
    );
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const writer = vi
      .fn()
      .mockRejectedValue(
        new Error("synthetic_audit_query", { cause: { sql: "synthetic_audit_sql" } }),
      );
    const r = await emit(
      "user.logged_in",
      { userId: 1 },
      {
        enabledModuleIds: new Set(["m"]),
        writer,
        source: "outbox",
        delivery: { outboxId: 12, originalSource: "moderation" },
      },
    );
    expect(r).toEqual({ dispatched: [{ moduleId: "m" }], errors: [], logged: false });
    expect(errorLog.mock.calls).toEqual([
      [
        "[kernel] event_log 落库失败（审计降级）",
        { category: "audit_write_failed", eventName: "user.logged_in", outboxId: 12 },
      ],
    ]);
  });

  it("未知事件在派发前被拒绝且不回显原值", async () => {
    const writer = vi.fn();
    await expect(emit("synthetic_unknown_event" as never, {} as never, { writer })).rejects.toThrow(
      /^\[kernel\] 未注册的事件名$/,
    );
    expect(writer).not.toHaveBeenCalled();
  });

  it("无消费者时静默落审计", async () => {
    const w = fakeWriter();
    const r = await emit(
      "badge.awarded",
      { userId: 3, badgeId: 9 },
      { enabledModuleIds: new Set(), writer: w.write },
    );
    expect(r.dispatched).toEqual([]);
    expect(r.logged).toBe(true);
    expect(w.rows).toHaveLength(1);
  });

  it("显式 actorId/source/now 透传审计行", async () => {
    const w = fakeWriter();
    const now = "2026-10-23 12:00:00";
    await emit(
      "user.logged_in",
      { userId: 5 },
      { enabledModuleIds: new Set(), writer: w.write, actorId: 42, source: "dev-api", now },
    );
    expect(w.rows[0].actorId).toBe(42);
    expect(w.rows[0].source).toBe("dev-api");
    expect(w.rows[0].createdAt).toBe(now);
  });
});
