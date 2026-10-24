import { describe, expect, it } from "vitest";
import type { ContentState } from "@/lib/authz/evaluator";
import {
  canDelete,
  canEdit,
  canRestore,
  type ActorFacts,
  type RuleDecision,
  type TargetFacts,
} from "./rules";

const STATES: ContentState[] = ["visible", "pending", "rejected", "hidden", "deleted"];

const actor = (over: Partial<ActorFacts> = {}): ActorFacts => ({
  userId: 1,
  isModerator: false,
  canWrite: true,
  ...over,
});
const target = (over: Partial<TargetFacts> = {}): TargetFacts => ({
  kind: "reply",
  authorId: 1,
  state: "visible",
  threadState: "visible",
  othersVisibleReplies: 0,
  ...over,
});
const code = (d: RuleDecision) => (d.allowed ? "ok" : d.code);

describe("canEdit", () => {
  it("作者改自己的 visible / pending：允许，不要理由，不用重新提交", () => {
    for (const state of ["visible", "pending"] as const)
      expect(canEdit(actor(), target({ state })), state).toEqual({
        allowed: true,
        reasonRequired: false,
        resubmit: false,
      });
  });

  it("作者改自己 rejected 的：允许，且需要重新提交审核", () => {
    expect(canEdit(actor(), target({ state: "rejected" }))).toEqual({
      allowed: true,
      reasonRequired: false,
      resubmit: true,
    });
  });

  it("作者不能动 hidden / deleted（那是版主的决定）", () => {
    expect(code(canEdit(actor(), target({ state: "hidden" })))).toBe("bad_state");
    expect(code(canEdit(actor(), target({ state: "deleted" })))).toBe("bad_state");
  });

  it("作者的 forum.write 失效（被禁言 / 封禁 / 版块归档）→ 不能再改自己的", () => {
    expect(code(canEdit(actor({ canWrite: false }), target()))).toBe("forbidden");
  });

  it("主题已被隐藏 / 删除：作者不能再改里面的回帖", () => {
    for (const threadState of ["hidden", "deleted"] as const)
      expect(code(canEdit(actor(), target({ threadState }))), threadState).toBe("thread_gone");
    // 对照：主题 pending / rejected 时作者仍能改（那是自己的待审内容）
    expect(code(canEdit(actor(), target({ threadState: "pending" })))).toBe("ok");
  });

  it("版主改别人的：除 deleted 外都允许，必须填理由；deleted 不能改", () => {
    for (const state of ["visible", "pending", "rejected", "hidden"] as const)
      expect(canEdit(actor({ userId: 9, isModerator: true }), target({ state })), state).toEqual({
        allowed: true,
        reasonRequired: true,
        resubmit: false,
      });
    expect(
      code(canEdit(actor({ userId: 9, isModerator: true }), target({ state: "deleted" }))),
    ).toBe("already_deleted");
  });

  it("版主改自己的、但 forum.write 已失效：按版主处理（要理由）；有 write 时按作者处理", () => {
    expect(canEdit(actor({ isModerator: true, canWrite: false }), target())).toMatchObject({
      allowed: true,
      reasonRequired: true,
    });
    expect(canEdit(actor({ isModerator: true, canWrite: true }), target())).toMatchObject({
      allowed: true,
      reasonRequired: false,
    });
  });

  it("无关的普通用户改别人的 → forbidden", () => {
    expect(code(canEdit(actor({ userId: 2 }), target()))).toBe("forbidden");
  });
});

describe("canDelete", () => {
  it("作者删自己的回帖：允许，不要理由", () => {
    expect(canDelete(actor(), target())).toEqual({
      allowed: true,
      reasonRequired: false,
      resubmit: false,
    });
  });

  it("作者删自己的主题：没有别人的可见回帖才行；有一条就不行（对照：0 条允许）", () => {
    expect(code(canDelete(actor(), target({ kind: "thread", othersVisibleReplies: 0 })))).toBe(
      "ok",
    );
    expect(code(canDelete(actor(), target({ kind: "thread", othersVisibleReplies: 1 })))).toBe(
      "has_replies",
    );
    expect(code(canDelete(actor(), target({ kind: "thread", othersVisibleReplies: 99 })))).toBe(
      "has_replies",
    );
  });

  it("作者不能删 hidden 的（版主的决定）；已删除的不能再删（任何人）", () => {
    expect(code(canDelete(actor(), target({ state: "hidden" })))).toBe("bad_state");
    expect(code(canDelete(actor(), target({ state: "deleted" })))).toBe("already_deleted");
    expect(
      code(canDelete(actor({ isModerator: true, userId: 9 }), target({ state: "deleted" }))),
    ).toBe("already_deleted");
  });

  it("作者的 forum.write 失效 → 不能删自己的；别人的帖子 → forbidden", () => {
    expect(code(canDelete(actor({ canWrite: false }), target()))).toBe("forbidden");
    expect(code(canDelete(actor({ userId: 2 }), target()))).toBe("forbidden");
  });

  it("主题已隐藏 / 删除：作者不能删里面的回帖", () => {
    expect(code(canDelete(actor(), target({ threadState: "deleted" })))).toBe("thread_gone");
  });

  it("版主：删别人的任何内容（包括有回复的主题）都允许，必须填理由；删自己的不要理由", () => {
    const mod = actor({ userId: 9, isModerator: true });
    expect(canDelete(mod, target({ kind: "thread", othersVisibleReplies: 5 }))).toMatchObject({
      allowed: true,
      reasonRequired: true,
    });
    for (const state of ["visible", "pending", "rejected", "hidden"] as const)
      expect(code(canDelete(mod, target({ state }))), state).toBe("ok");
    expect(canDelete(actor({ isModerator: true }), target())).toMatchObject({
      allowed: true,
      reasonRequired: false,
    });
  });
});

describe("canRestore", () => {
  const mod = actor({ userId: 9, isModerator: true });

  it("只有版主能恢复，必须填理由；只针对 deleted / hidden", () => {
    for (const state of ["deleted", "hidden"] as const)
      expect(canRestore(mod, target({ state })), state).toMatchObject({
        allowed: true,
        reasonRequired: true,
      });
    for (const state of ["visible", "pending", "rejected"] as const)
      expect(code(canRestore(mod, target({ state }))), state).toBe("not_restorable");
  });

  it("作者不能恢复自己删的（避免绕过版主的删除决定）——不管什么状态", () => {
    for (const state of STATES)
      expect(code(canRestore(actor(), target({ state }))), state).toBe("forbidden");
  });
});

describe("全状态矩阵（防止新增状态漏判）", () => {
  it("每个动作对每个状态、每种身份都有明确结论（没有 undefined / 抛错）", () => {
    for (const state of STATES)
      for (const threadState of STATES)
        for (const kind of ["thread", "reply"] as const)
          for (const a of [
            actor(),
            actor({ canWrite: false }),
            actor({ userId: 2 }),
            actor({ userId: 2, isModerator: true }),
          ])
            for (const fn of [canEdit, canDelete, canRestore]) {
              const d = fn(a, target({ state, threadState, kind, othersVisibleReplies: 1 }));
              expect(typeof d.allowed).toBe("boolean");
            }
  });
});
