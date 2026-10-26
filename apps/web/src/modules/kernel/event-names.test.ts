import { describe, expect, it } from "vitest";
import { EVENT_NAMES, isEventName, validateEventPayload } from "./event-names";
import type { EventPayloads } from "./types";

describe("EVENT_NAMES / isEventName", () => {
  it("清单完整（23 事件，与 docs/MODULES.md 一致）", () => {
    expect(EVENT_NAMES).toHaveLength(23);
    expect(new Set(EVENT_NAMES).size).toBe(24);
    expect(EVENT_NAMES).toContain("points.changed");
    expect(EVENT_NAMES).not.toContain("credit.changed");
    expect(EVENT_NAMES).not.toContain("medal.awarded");
  });

  it("识别合法/非法事件名", () => {
    expect(isEventName("user.logged_in")).toBe(true);
    expect(isEventName("nope")).toBe(false);
    expect(isEventName(42)).toBe(false);
  });
});

describe("validateEventPayload", () => {
  it("合法 payload 通过", () => {
    expect(validateEventPayload("user.logged_in", { userId: 1 })).toBeNull();
    expect(
      validateEventPayload("thread.created", {
        threadId: 1,
        postId: 4,
        forumId: 2,
        authorId: 3,
        title: "t",
      }),
    ).toBeNull();
  });

  it("缺字段报出缺失键", () => {
    expect(validateEventPayload("user.logged_in", {})).toContain("userId");
    expect(validateEventPayload("points.changed", { userId: 1 })).toContain("channel");
    expect(validateEventPayload("gate.unlocked", { gateId: 1 })).toContain("authorId");
  });

  it("非对象 payload 拒绝", () => {
    expect(validateEventPayload("user.logged_in", null)).toContain("对象");
    expect(validateEventPayload("user.logged_in", [1])).toContain("对象");
    expect(validateEventPayload("user.logged_in", "x")).toContain("对象");
  });

  it("额外字段不拒绝（宽容写入，raw 归档哲学一致）", () => {
    const p: EventPayloads["user.logged_in"] & { extra?: string } = { userId: 1 };
    p.extra = "ok";
    expect(validateEventPayload("user.logged_in", p)).toBeNull();
  });
});
