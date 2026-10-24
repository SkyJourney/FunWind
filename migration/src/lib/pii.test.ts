import { describe, expect, it } from "vitest";
import { maskEmail } from "./pii.js";

describe("maskEmail", () => {
  it("保留首字符与域名，隐藏本地部分", () => {
    expect(maskEmail("jane@126.com")).toBe("j***@126.com");
    expect(maskEmail("7654321@qq.com")).toBe("7***@qq.com");
  });

  it("单字符本地部分、含引号的非法邮箱也不泄露本地部分", () => {
    expect(maskEmail("a@x.io")).toBe("a***@x.io");
    expect(maskEmail("dong'shi@163.com")).toBe("d***@163.com");
  });

  it("没有 @ 或本地部分为空：整体隐藏", () => {
    expect(maskEmail("nope")).toBe("***");
    expect(maskEmail("@x.io")).toBe("***");
    expect(maskEmail("")).toBe("***");
  });

  it("输出不包含原本地部分的第二个及之后的字符", () => {
    const out = maskEmail("secretname@x.io");
    expect(out).not.toContain("ecret");
  });
});
