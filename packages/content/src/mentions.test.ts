import { describe, expect, it } from "vitest";
import { extractMentionSpans, extractMentionTokens } from "./mentions";

describe("@提及解析（M8）", () => {
  it("行首与空白后的 @ 提取候选；全角标点截断", () => {
    expect(extractMentionTokens("@alice 看看这个")).toEqual(["alice"]);
    expect(extractMentionTokens("叫上 @bob 和 @carol 一起")).toEqual(["bob", "carol"]);
    expect(extractMentionTokens("@alice，谢谢你")).toEqual(["alice"]); // 全角逗号截断
    expect(extractMentionTokens("（@dave）看")).toEqual(["dave"]);
  });

  it("email 与夹在词中的 @ 不算提及", () => {
    expect(extractMentionTokens("发邮件到 bob@example.com")).toEqual([]);
    expect(extractMentionTokens("a@b")).toEqual([]);
    expect(extractMentionTokens("密码是 ab@cd")).toEqual([]);
  });

  it("去重且保序；超过 32 字符的 token 截断", () => {
    expect(extractMentionTokens("@alice 和 @alice 和 @bob")).toEqual(["alice", "bob"]);
    const long = "x".repeat(40);
    expect(extractMentionTokens(`@${long}`)).toEqual(["x".repeat(32)]);
  });

  it("span 位置正确（供调用方做上下文用）", () => {
    const spans = extractMentionSpans("hi @alice!");
    expect(spans).toEqual([{ token: "alice", start: 3, end: 9 }]);
  });

  it("空串与无提及输入返回空", () => {
    expect(extractMentionTokens("")).toEqual([]);
    expect(extractMentionTokens("没有提及的正文。")).toEqual([]);
    expect(extractMentionTokens("@ 单独的 at 符号")).toEqual([]);
  });
});
