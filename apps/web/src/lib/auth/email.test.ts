import { describe, expect, it } from "vitest";
import { MAX_EMAIL_LENGTH, isValidEmail } from "./email";

describe("isValidEmail", () => {
  it("常见合法邮箱通过（含加号、点、连字符、子域、多级域名）", () => {
    for (const e of [
      "a@b.co",
      "alice@example.com",
      "first.last+tag@mail.example.co.uk",
      "x_y-z@sub-domain.example.org",
      "o'brien@example.com",
      "1234567890@qq.com",
    ])
      expect(isValidEmail(e), e).toBe(true);
  });

  it("对照：旧正则放过的这些现在被拒——逗号 / 分号 / 引号 / 括号 / 尖括号 / 空白", () => {
    const OLD = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    for (const e of [
      "a,b@x.com",
      "a;b@x.com",
      'a"b@x.com',
      "a(b)@x.com",
      "a<b>@x.com",
      "a@x,y.com",
      "a b@x.com",
      "<a@x.com>",
    ]) {
      if (!/\s/.test(e)) expect(OLD.test(e), `旧正则应放过 ${e}（对照）`).toBe(true);
      expect(isValidEmail(e), e).toBe(false);
    }
  });

  it("结构错误被拒：缺 @ / 缺域名点 / 空本地部分 / 连续点 / 首尾点 / 域名标签首尾连字符 / 多个 @", () => {
    for (const e of [
      "",
      "plain",
      "a@b",
      "@x.com",
      "a..b@x.com",
      ".a@x.com",
      "a.@x.com",
      "a@-x.com",
      "a@x-.com",
      "a@.com",
      "a@x..com",
      "a@@x.com",
      "a@b@x.com",
      "a@x.com,b@y.com",
    ])
      expect(isValidEmail(e), e).toBe(false);
  });

  it("长度上限：整体 ≤254、本地部分 ≤64", () => {
    expect(isValidEmail(`${"a".repeat(64)}@x.com`)).toBe(true);
    expect(isValidEmail(`${"a".repeat(65)}@x.com`)).toBe(false);
    const long = `a@${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.${"e".repeat(60)}.${"f".repeat(10)}.com`;
    expect(long.length).toBeGreaterThan(MAX_EMAIL_LENGTH);
    expect(isValidEmail(long)).toBe(false);
  });

  it("不会被病态输入拖死（无灾难性回溯）", () => {
    const t0 = Date.now();
    isValidEmail(`${"a.".repeat(30)}!@${"b-".repeat(30)}`);
    isValidEmail(`${"a".repeat(60)}@${"x.".repeat(100)}`);
    expect(Date.now() - t0).toBeLessThan(200);
  });
});
