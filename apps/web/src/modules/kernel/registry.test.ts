import { beforeEach, describe, expect, it } from "vitest";
import {
  collectBoundary,
  getEventConsumers,
  getModule,
  getModules,
  getSlotRenderers,
  registerModule,
  resetRegistryForTests,
  sealRegistry,
} from "./registry.js";
import { defineModule, type EventPayloads } from "./types.js";

function mod(id: string, extra: Partial<Parameters<typeof defineModule>[0]> = {}) {
  return defineModule({ id, description: `模块 ${id}`, ...extra });
}

beforeEach(() => resetRegistryForTests());

describe("registerModule", () => {
  it("正常注册并可查询", () => {
    registerModule(mod("demo-a"));
    expect(getModules().map((m) => m.id)).toEqual(["demo-a"]);
    expect(getModule("demo-a")?.description).toBe("模块 demo-a");
  });

  it("重复注册抛错（唯一性门禁）", () => {
    registerModule(mod("dup"));
    expect(() => registerModule(mod("dup"))).toThrow(/重复注册/);
  });

  it("拒绝非法 id（非 kebab-case）", () => {
    expect(() => registerModule(mod("Demo_A"))).toThrow(/kebab-case/);
  });

  it("封板后拒绝运行时注册", () => {
    sealRegistry();
    expect(() => registerModule(mod("late"))).toThrow(/封板/);
  });
});

describe("getEventConsumers / getSlotRenderers", () => {
  it("按注册序收集消费者与渲染器", () => {
    registerModule(
      mod("first", {
        events: { "user.logged_in": () => {} },
        slots: { "home.footer-notice": () => null },
      }),
    );
    registerModule(
      mod("second", {
        events: { "user.logged_in": () => {} },
        slots: { "home.footer-notice": () => null },
      }),
    );
    expect(getEventConsumers("user.logged_in").map((c) => c.moduleId)).toEqual(["first", "second"]);
    expect(getSlotRenderers("home.footer-notice").map((s) => s.moduleId)).toEqual([
      "first",
      "second",
    ]);
    // 未注册的事件/槽位返回空
    expect(getEventConsumers("checkin.done")).toEqual([]);
    expect(getSlotRenderers("home.after-header")).toEqual([]);
  });

  it("消费者收到正确的事件载荷类型（运行时透传）", async () => {
    const seen: EventPayloads["credit.changed"][] = [];
    registerModule(mod("watch", { events: { "credit.changed": (p) => void seen.push(p) } }));
    const [c] = getEventConsumers("credit.changed");
    await c.consume({ userId: 1, creditType: "1", delta: 5 });
    expect(seen).toEqual([{ userId: 1, creditType: "1", delta: 5 }]);
  });
});

describe("collectBoundary", () => {
  it("汇聚各模块的注册边界（导航为例）", () => {
    registerModule(mod("a", { nav: [{ id: "a1", label: "A", href: "/a" }] }));
    registerModule(mod("b", { nav: [{ id: "b1", label: "B", href: "/b", order: 1 }] }));
    const nav = collectBoundary("nav");
    expect(nav).toHaveLength(2);
    expect(nav[0][0]?.id).toBe("a1");
  });

  it("无边界的模块被跳过", () => {
    registerModule(mod("plain"));
    expect(collectBoundary("cron")).toEqual([]);
  });
});
