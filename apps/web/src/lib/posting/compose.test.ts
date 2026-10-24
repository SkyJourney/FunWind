/**
 * 发主题页的展示决策与错误文案（纯函数）。覆盖判定顺序、审核提示、错误码白名单与通用兜底。
 */
import { describe, expect, it } from "vitest";
import { composeAccess, type ComposeFacts, POSTING_FALLBACK, postingNoticeText } from "./compose";

const base: ComposeFacts = {
  isGuest: false,
  canWrite: true,
  isSection: false,
  archived: false,
  reviewPolicy: "none",
};

describe("composeAccess：发帖入口的展示", () => {
  it("能写 → 表单；不审核时不带审核提示", () => {
    expect(composeAccess(base)).toEqual({ mode: "form", reviewHint: false });
  });

  it("能写且版块审核主题（threads / all）→ 表单，并带审核提示", () => {
    expect(composeAccess({ ...base, reviewPolicy: "threads" })).toEqual({
      mode: "form",
      reviewHint: true,
    });
    expect(composeAccess({ ...base, reviewPolicy: "all" })).toEqual({
      mode: "form",
      reviewHint: true,
    });
  });

  it("游客不能写 → 提示登录，并给出登录地址", () => {
    expect(composeAccess({ ...base, isGuest: true, canWrite: false })).toEqual({
      mode: "closed",
      text: "登录后可在该版块发帖。",
      loginHref: "/login",
    });
  });

  it("归档（自身或祖先）→ 说明归档，不给登录地址", () => {
    expect(composeAccess({ ...base, canWrite: false, archived: true })).toEqual({
      mode: "closed",
      text: "该版块已归档，暂不接受新内容。",
      loginHref: null,
    });
  });

  it("分区 → 提示进入其中的版块发帖", () => {
    expect(composeAccess({ ...base, canWrite: false, isSection: true })).toEqual({
      mode: "closed",
      text: "这是分区，请进入其中的版块发帖。",
      loginHref: null,
    });
  });

  it("其它不能写的情形（如无授权）→ 通用说明", () => {
    expect(composeAccess({ ...base, canWrite: false })).toEqual({
      mode: "closed",
      text: "你暂时不能在该版块发帖。",
      loginHref: null,
    });
  });

  it("判定顺序：游客优先于归档与分区；归档优先于分区", () => {
    expect(
      composeAccess({ ...base, isGuest: true, canWrite: false, archived: true, isSection: true }),
    ).toMatchObject({ text: "登录后可在该版块发帖。" });
    expect(
      composeAccess({ ...base, canWrite: false, archived: true, isSection: true }),
    ).toMatchObject({ text: "该版块已归档，暂不接受新内容。" });
  });

  it("能写时，归档 / 分区的事实不会覆盖表单（判定权在评估器，这里只看结论）", () => {
    expect(composeAccess({ ...base, archived: true })).toEqual({ mode: "form", reviewHint: false });
  });
});

describe("postingNoticeText：发帖错误码 → 固定文案", () => {
  it("没有错误码 → null（不渲染提示）", () => {
    expect(postingNoticeText(undefined)).toBeNull();
  });

  it("白名单内的码返回对应文案", () => {
    expect(postingNoticeText("title_empty")).toBe("请填写标题。");
    expect(postingNoticeText("body_too_long")).toBe("正文太长了，请精简后再发。");
    expect(postingNoticeText("quota_exceeded")).toBe("今日发主题次数已达上限，明天再来吧。");
  });

  it("未知码、空串一律通用文案，不把错误码原样显示", () => {
    expect(postingNoticeText("not_a_code")).toBe(POSTING_FALLBACK);
    expect(postingNoticeText("")).toBe(POSTING_FALLBACK);
    expect(postingNoticeText("<img src=x>")).toBe(POSTING_FALLBACK);
  });

  it("原型链上的键不算错误码（不能因 Object.prototype 误命中）", () => {
    expect(postingNoticeText("constructor")).toBe(POSTING_FALLBACK);
    expect(postingNoticeText("__proto__")).toBe(POSTING_FALLBACK);
  });
});
