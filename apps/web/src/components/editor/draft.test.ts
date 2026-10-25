// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAllDrafts,
  clearDraftsForUser,
  draftKey,
  readDraft,
  removeDraft,
  stageDraft,
  stagedKey,
  writeDraft,
} from "./draft";

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("草稿键", () => {
  it("包含用户、类型与对象号；游客用 guest", () => {
    expect(draftKey(7, "thread", 3)).toBe("funwind:draft:7:thread:3");
    expect(draftKey(null, "reply", 12)).toBe("funwind:draft:guest:reply:12");
    expect(draftKey(7, "edit", "9")).toBe("funwind:draft:7:edit:9");
  });
});

describe("读写删除", () => {
  it("写入后可读出，删除后为空", () => {
    writeDraft("k", "内容");
    expect(readDraft("k")).toBe("内容");
    removeDraft("k");
    expect(readDraft("k")).toBeNull();
  });

  it("存储抛异常时降级：读返回 null，写与删不抛出", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readDraft("k")).toBeNull();
    expect(() => writeDraft("k", "x")).not.toThrow();
    expect(() => removeDraft("k")).not.toThrow();
  });
});

describe("清理", () => {
  it("clearDraftsForUser 只删除该用户的草稿，保留其它用户与无关键", () => {
    writeDraft(draftKey(1, "thread", 1), "a");
    writeDraft(draftKey(1, "reply", 2), "b");
    writeDraft(draftKey(2, "thread", 1), "c");
    window.localStorage.setItem("unrelated", "keep");
    clearDraftsForUser(1);
    expect(readDraft(draftKey(1, "thread", 1))).toBeNull();
    expect(readDraft(draftKey(1, "reply", 2))).toBeNull();
    expect(readDraft(draftKey(2, "thread", 1))).toBe("c");
    expect(window.localStorage.getItem("unrelated")).toBe("keep");
  });

  it("clearAllDrafts 删除全部草稿键，不碰其它键（退出登录）", () => {
    writeDraft(draftKey(1, "thread", 1), "a");
    writeDraft(draftKey(null, "edit", 5), "b");
    window.localStorage.setItem("unrelated", "keep");
    clearAllDrafts();
    expect(window.localStorage.length).toBe(1);
    expect(window.localStorage.getItem("unrelated")).toBe("keep");
  });

  it("清理时存储抛异常：不抛出", () => {
    vi.spyOn(Storage.prototype, "key").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(() => clearDraftsForUser(1)).not.toThrow();
    expect(() => clearAllDrafts()).not.toThrow();
  });
});

describe("提交暂存", () => {
  it("有草稿：主键清除，正文移入暂存键", () => {
    writeDraft("k", "正文");
    stageDraft("k");
    expect(readDraft("k")).toBeNull();
    expect(readDraft(stagedKey("k"))).toBe("正文");
  });

  it("没有草稿：暂存键也清空（失败跳回时回到服务端原文）", () => {
    writeDraft(stagedKey("k"), "上一次提交的正文");
    stageDraft("k");
    expect(readDraft(stagedKey("k"))).toBeNull();
  });

  it("暂存键属于同一用户前缀，退出登录时一并清除", () => {
    const key = draftKey(3, "reply", 9);
    writeDraft(key, "a");
    stageDraft(key);
    clearDraftsForUser(3);
    expect(readDraft(stagedKey(key))).toBeNull();
  });
});
