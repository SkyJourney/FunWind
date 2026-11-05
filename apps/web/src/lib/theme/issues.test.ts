import { describe, expect, it } from "vitest";
import {
  MAX_ISSUES_CARRIED,
  MAX_ISSUES_SHOWN,
  MAX_ISSUE_LENGTH,
  encodeIssues,
  parseIssues,
} from "./issues";

const decode = (fragment: string) => [
  ...new URLSearchParams(fragment.replace(/^&/, "")).getAll("issue"),
];

describe("限额", () => {
  it("带回 6 条、展示 5 条、每条 120 字符；多带 1 条用来判断有没有被省略的", () => {
    expect(MAX_ISSUES_CARRIED).toBe(6);
    expect(MAX_ISSUES_SHOWN).toBe(5);
    expect(MAX_ISSUE_LENGTH).toBe(120);
    expect(MAX_ISSUES_CARRIED).toBe(MAX_ISSUES_SHOWN + 1);
  });
});

describe("encodeIssues", () => {
  it("没有问题：空串", () => {
    expect(encodeIssues(undefined)).toBe("");
    expect(encodeIssues([])).toBe("");
    expect(encodeIssues(["", "   "])).toBe("");
  });

  it("每条一个 issue 参数，顺序不变，特殊字符被编码", () => {
    const issues = ["surfaces.header.light.blur: Too big", "a&b=c#d: 含 & = # 空格"];
    const fragment = encodeIssues(issues);
    expect(fragment.startsWith("&issue=")).toBe(true);
    expect(fragment).not.toMatch(/[ #]/);
    expect(decode(fragment)).toEqual(issues);
  });

  it("去掉首尾空白和空串", () => {
    expect(decode(encodeIssues(["  甲  ", "", "乙"]))).toEqual(["甲", "乙"]);
  });

  it("最多带 6 条，空串不占名额", () => {
    const many = Array.from({ length: 10 }, (_, i) => `问题${i}`);
    expect(decode(encodeIssues(many))).toEqual(many.slice(0, 6));
    expect(decode(encodeIssues(["", ...many]))).toEqual(many.slice(0, 6));
  });

  it("恰好 120 字符不动；121 字符截成 119 字符加省略号，仍是 120", () => {
    const exact = "字".repeat(120);
    expect(decode(encodeIssues([exact]))).toEqual([exact]);
    const long = "字".repeat(121);
    const [cut] = decode(encodeIssues([long]));
    expect([...cut]).toHaveLength(120);
    expect(cut).toBe(`${"字".repeat(119)}…`);
  });

  it("按码点截断：不会把代理对劈成两半", () => {
    const long = "😀".repeat(130);
    const [cut] = decode(encodeIssues([long]));
    expect(cut).toBe(`${"😀".repeat(119)}…`);
    expect(cut).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it("整条查询串有上限：6 条 × 120 字符的汉字，编码后仍远小于 8KB", () => {
    const worst = Array.from({ length: 6 }, () => "汉".repeat(120));
    expect(encodeIssues(worst).length).toBeLessThan(8 * 1024);
  });

  it("不改入参", () => {
    const issues = ["  甲  ", "乙"];
    encodeIssues(issues);
    expect(issues).toEqual(["  甲  ", "乙"]);
  });
});

describe("parseIssues", () => {
  it("缺省：空列表", () => {
    expect(parseIssues(undefined)).toEqual([]);
  });

  it("单个字符串与字符串数组都接受", () => {
    expect(parseIssues("甲")).toEqual(["甲"]);
    expect(parseIssues(["甲", "乙"])).toEqual(["甲", "乙"]);
  });

  it("不信任查询参数：同样去空白、丢空串、限条数、限长度", () => {
    expect(parseIssues(["  甲 ", "", "  "])).toEqual(["甲"]);
    expect(parseIssues(Array.from({ length: 20 }, (_, i) => `p${i}`))).toHaveLength(6);
    const [cut] = parseIssues("字".repeat(500));
    expect([...cut]).toHaveLength(120);
    expect(cut.endsWith("…")).toBe(true);
  });

  it("数组里混进非字符串也不炸", () => {
    expect(parseIssues(["甲", 1, null, undefined, {}, "乙"] as unknown as string[])).toEqual([
      "甲",
      "乙",
    ]);
  });

  it("与 encodeIssues 往返一致", () => {
    const issues = ["pwa.themeColor: 非法颜色（须 #RRGGBB）", "tokens.light.band.width: Too big"];
    const params = new URLSearchParams(encodeIssues(issues).replace(/^&/, ""));
    expect(parseIssues(params.getAll("issue"))).toEqual(issues);
  });
});
