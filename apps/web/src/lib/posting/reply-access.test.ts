/**
 * 快速回复入口的展示决策（纯函数）：判定顺序、锁定与归档的提示、回复审核提示的范围，以及回复错误码的文案。
 */
import { describe, expect, it } from "vitest";
import { POSTING_FALLBACK, postingNoticeText, replyAccess, type ReplyFacts } from "./compose";

const base: ReplyFacts = {
  isGuest: false,
  canWrite: true,
  archived: false,
  threadLocked: false,
  reviewPolicy: "none",
};

describe("replyAccess：快速回复入口", () => {
  it("能写 → 表单，不带审核提示", () => {
    expect(replyAccess(base)).toEqual({ mode: "form", reviewHint: false });
  });

  it("只有「全部审核」才提示回复需要审核；仅审核主题时回复直接可见", () => {
    expect(replyAccess({ ...base, reviewPolicy: "all" })).toEqual({
      mode: "form",
      reviewHint: true,
    });
    expect(replyAccess({ ...base, reviewPolicy: "threads" })).toEqual({
      mode: "form",
      reviewHint: false,
    });
  });

  it("游客 → 提示登录", () => {
    expect(replyAccess({ ...base, isGuest: true, canWrite: false })).toEqual({
      mode: "closed",
      text: "登录后可回复。",
      loginHref: "/login",
    });
  });

  it("归档 → 说明归档", () => {
    expect(replyAccess({ ...base, canWrite: false, archived: true })).toEqual({
      mode: "closed",
      text: "该版块已归档，暂不接受新内容。",
      loginHref: null,
    });
  });

  it("主题锁定且不能写（无 thread.replyLocked）→ 说明锁定", () => {
    expect(replyAccess({ ...base, canWrite: false, threadLocked: true })).toEqual({
      mode: "closed",
      text: "主题已锁定，暂不接受回复。",
      loginHref: null,
    });
  });

  it("判定顺序：游客优先于归档与锁定；归档优先于锁定", () => {
    expect(
      replyAccess({ ...base, isGuest: true, canWrite: false, archived: true, threadLocked: true }),
    ).toMatchObject({ text: "登录后可回复。" });
    expect(
      replyAccess({ ...base, canWrite: false, archived: true, threadLocked: true }),
    ).toMatchObject({ text: "该版块已归档，暂不接受新内容。" });
  });

  it("其它不能写的情形 → 通用说明", () => {
    expect(replyAccess({ ...base, canWrite: false })).toEqual({
      mode: "closed",
      text: "你暂时不能回复该主题。",
      loginHref: null,
    });
  });

  it("锁定的主题若持有 replyLocked（canWrite 为真）→ 仍然给出表单", () => {
    expect(replyAccess({ ...base, threadLocked: true, canWrite: true })).toEqual({
      mode: "form",
      reviewHint: false,
    });
  });
});

describe("回复错误码的文案", () => {
  it("回复相关的错误码有固定文案", () => {
    expect(postingNoticeText("thread_closed")).toBe("该主题暂不接受回复。");
    expect(postingNoticeText("thread_locked")).toBe("主题已锁定，暂不接受回复。");
    expect(postingNoticeText("not_found")).toBe("该主题不存在或你无法查看，无法回复。");
  });

  it("未知码仍走通用兜底", () => {
    expect(postingNoticeText("reply_target_weird")).toBe(POSTING_FALLBACK);
  });
});
