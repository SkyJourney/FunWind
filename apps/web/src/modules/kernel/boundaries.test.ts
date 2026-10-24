import { beforeEach, describe, expect, it } from "vitest";
import { emit } from "./bus";
import { BUILTIN_POINT_CHANNELS } from "./builtin";
import { EVENT_NAMES, REQUIRED_PAYLOAD_KEYS } from "./event-names";
import {
  getNotificationChannelDecls,
  getNotificationTypeDecls,
  getPointChannelDecls,
  registerModule,
  resetRegistryForTests,
} from "./registry";
import { defineModule } from "./types";

const mod = (id: string, extra: Partial<Parameters<typeof defineModule>[0]> = {}) =>
  defineModule({ id, description: `模块 ${id}`, ...extra });
const channel = (key: string, direction: "earn" | "spend" | "adjust" = "earn") => ({
  key,
  direction,
  label: "测试渠道",
});
beforeEach(() => resetRegistryForTests());

describe("事件清单一致性", () => {
  it("每个事件都有必填键定义，且 actor 映射对每个事件都指向其必填键之一", async () => {
    for (const name of EVENT_NAMES) {
      expect(REQUIRED_PAYLOAD_KEYS[name], name).toBeDefined();
      expect(REQUIRED_PAYLOAD_KEYS[name].length, name).toBeGreaterThan(0);
    }
    // 动作发起者按 docs/MODULES.md §3 解析：用最小合法 payload 走一遍总线，核对落库的 actorId
    const cases: [(typeof EVENT_NAMES)[number], Record<string, unknown>, number][] = [
      ["thread.moderated", { threadId: 1, operatorId: 7, action: "pin" }, 7],
      ["content.moderated", { postId: 1, operatorId: 8, action: "hide" }, 8],
      ["restriction.changed", { userId: 1, kind: "mute", action: "created", operatorId: 9 }, 9],
      [
        "role.changed",
        { userId: 1, roleKey: "x", scopeId: 0, action: "granted", operatorId: 10 },
        10,
      ],
      ["announcement.published", { announcementId: 1, createdBy: 11 }, 11],
      ["message.sent", { conversationId: 1, messageId: 1, senderId: 12, recipientId: 2 }, 12],
      ["content.submitted", { postId: 1, authorId: 13, forumId: 1, pending: true }, 13],
      ["post.mentioned", { postId: 1, authorId: 14, mentionedUserId: 2 }, 14],
      ["gate.unlocked", { gateId: 1, userId: 15, authorId: 2, price: 5 }, 15],
      ["points.changed", { userId: 16, channel: "earn.x", delta: 1 }, 16],
      ["user.followed", { userId: 17, targetType: "user", targetId: 2 }, 17],
    ];
    for (const [name, payload, actor] of cases) {
      const rows: { actorId: number | null }[] = [];
      await emit(name, payload as never, {
        enabledModuleIds: new Set(),
        writer: async (r) => void rows.push(r),
      });
      expect(rows[0]?.actorId, name).toBe(actor);
    }
  });
});

describe("积分渠道注册校验", () => {
  it("合法声明通过，可从注册表按模块取出", () => {
    registerModule(
      mod("rewards", { pointChannels: [channel("earn.post"), channel("spend.shop", "spend")] }),
    );
    expect(getPointChannelDecls().map((d) => [d.moduleId, d.def.key])).toEqual([
      ["rewards", "earn.post"],
      ["rewards", "spend.shop"],
    ]);
  });

  it("键必须形如 earn./spend./adjust. 命名空间", () => {
    for (const key of ["post", "bonus.post", "earn.", "earn.Post", "earn post", "opening"]) {
      expect(
        () =>
          registerModule(
            mod("m" + Math.random().toString(36).slice(2), { pointChannels: [channel(key)] }),
          ),
        key,
      ).toThrow(/积分渠道/);
    }
  });

  it("方向必须与键前缀一致（spend.* 不能声明为 earn）", () => {
    expect(() =>
      registerModule(mod("m", { pointChannels: [channel("spend.shop", "earn")] })),
    ).toThrow(/方向/);
    expect(() =>
      registerModule(mod("m2", { pointChannels: [channel("earn.x", "spend")] })),
    ).toThrow(/方向/);
    registerModule(mod("m3", { pointChannels: [channel("adjust.admin", "adjust")] }));
  });

  it("与内置渠道、与其他模块、模块内部重名都拒绝", () => {
    // opening 不符合命名空间格式，先被键格式拒绝；其余内置渠道走重名/内置冲突校验
    BUILTIN_POINT_CHANNELS.forEach((b, i) => {
      expect(() =>
        registerModule(mod(`builtin-clash-${i}`, { pointChannels: [channel(b.key, b.direction)] })),
      ).toThrow(b.key === "opening" ? /键非法/ : /与内置冲突/);
    });
    registerModule(mod("first", { pointChannels: [channel("earn.dup")] }));
    expect(() => registerModule(mod("second", { pointChannels: [channel("earn.dup")] }))).toThrow(
      /重复/,
    );
    expect(() =>
      registerModule(mod("third", { pointChannels: [channel("earn.same"), channel("earn.same")] })),
    ).toThrow(/重复/);
  });

  it("缺少 label 拒绝", () => {
    expect(() =>
      registerModule(
        mod("m", { pointChannels: [{ key: "earn.x", direction: "earn", label: " " }] }),
      ),
    ).toThrow(/label/);
  });
});

describe("通知类型与渠道注册校验", () => {
  const type = (key: string, category: string) => ({
    key,
    category: category as never,
    aggregate: false,
    mandatory: false,
  });

  it("合法类型通过；分类必须是四类之一；键必须唯一且为命名空间形态", () => {
    registerModule(mod("n1", { notificationTypes: [type("badge.awarded", "account")] }));
    expect(getNotificationTypeDecls()).toHaveLength(1);
    expect(() => registerModule(mod("n2", { notificationTypes: [type("x.y", "weird")] }))).toThrow(
      /分类/,
    );
    expect(() =>
      registerModule(mod("n3", { notificationTypes: [type("nodot", "account")] })),
    ).toThrow(/键非法/);
    expect(() =>
      registerModule(mod("n4", { notificationTypes: [type("badge.awarded", "account")] })),
    ).toThrow(/重复/);
  });

  it("通知渠道：in_app 为保留键；重名拒绝", () => {
    const ch = (key: string) => ({ key, deliver: async () => {} });
    registerModule(mod("c1", { notificationChannels: [ch("email")] }));
    expect(getNotificationChannelDecls().map((d) => d.def.key)).toEqual(["email"]);
    expect(() => registerModule(mod("c2", { notificationChannels: [ch("in_app")] }))).toThrow(
      /保留/,
    );
    expect(() => registerModule(mod("c3", { notificationChannels: [ch("email")] }))).toThrow(
      /重复/,
    );
  });

  it("校验失败不会留下半注册的模块", () => {
    expect(() => registerModule(mod("bad", { pointChannels: [channel("nope")] }))).toThrow();
    expect(() => registerModule(mod("bad"))).not.toThrow(); // id 未被占用，可再注册
  });
});
