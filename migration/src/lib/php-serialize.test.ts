import { describe, expect, it } from "vitest";
import {
  isTruthy,
  parsePermissionValue,
  phpUnserialize,
  PhpSerializeError,
} from "./php-serialize.js";

describe("phpUnserialize", () => {
  it("标量类型", () => {
    expect(phpUnserialize("N;")).toBeNull();
    expect(phpUnserialize("b:1;")).toBe(true);
    expect(phpUnserialize("b:0;")).toBe(false);
    expect(phpUnserialize("i:42;")).toBe(42);
    expect(phpUnserialize("d:1.5;")).toBe(1.5);
    expect(phpUnserialize('s:3:"abc";')).toBe("abc");
  });

  it("旧站权限值：售帖/隐藏数组", () => {
    expect(phpUnserialize('a:2:{s:4:"sell";s:1:"1";s:4:"hide";s:1:"1";}')).toEqual({
      sell: "1",
      hide: "1",
    });
    expect(phpUnserialize('a:1:{s:4:"hide";s:1:"1";}')).toEqual({ hide: "1" });
  });

  it("嵌套数组与整型键", () => {
    expect(phpUnserialize('a:2:{i:0;s:1:"a";i:1;a:1:{s:1:"k";i:7;}}')).toEqual({
      "0": "a",
      "1": { k: 7 },
    });
  });

  it("多字节字符：长度按 UTF-8 字节数", () => {
    expect(phpUnserialize('s:6:"中文";')).toBe("中文");
  });

  it("GBK 转 UTF-8 后长度失配时回退到查找结尾引号", () => {
    // 原 GBK 字节数为 4，转 UTF-8 后实际是 6 字节
    expect(phpUnserialize('s:4:"中文";')).toBe("中文");
    expect(phpUnserialize('a:1:{s:1:"k";s:2:"汉字";}')).toEqual({ k: "汉字" });
  });

  it("非法输入抛 PhpSerializeError，不猜测", () => {
    for (const bad of [
      "",
      "x",
      'a:1:{s:1:"k";}',
      'a:1:{s:1:"k";s:1:"v";',
      "i:1;extra",
      "s:3:abc;",
      's:-1:"";',
    ]) {
      expect(() => phpUnserialize(bad), bad).toThrow(PhpSerializeError);
    }
  });
});

describe("isTruthy（PHP 真值）", () => {
  it("标量", () => {
    expect(isTruthy(null)).toBe(false);
    expect(isTruthy(true)).toBe(true);
    expect(isTruthy(false)).toBe(false);
    expect(isTruthy(0)).toBe(false);
    expect(isTruthy(3)).toBe(true);
    expect(isTruthy("")).toBe(false);
    expect(isTruthy("0")).toBe(false);
    expect(isTruthy("1")).toBe(true);
    expect(isTruthy("abc")).toBe(true);
  });

  it("数组：任一元素为真即为真；空数组与全假数组为假", () => {
    expect(isTruthy({ a: "0", b: "1" })).toBe(true);
    expect(isTruthy({ a: "0", b: "" })).toBe(false);
    expect(isTruthy({})).toBe(false);
  });
});

describe("parsePermissionValue", () => {
  it("纯标量直接按字符串返回；a: 开头按序列化解析", () => {
    expect(parsePermissionValue("1")).toBe("1");
    expect(parsePermissionValue(" 0 ")).toBe("0");
    expect(parsePermissionValue(null)).toBe("");
    expect(parsePermissionValue('a:1:{s:9:"user_check";s:1:"1";}')).toEqual({ user_check: "1" });
  });

  it("序列化值损坏时抛错，由调用方计入报告（不再误判为开启）", () => {
    expect(() => parsePermissionValue('a:1:{s:1:"1"')).toThrow(PhpSerializeError);
    // v1 的字符串匹配会把这个当作「开启」，这里必须显式失败
    expect(() => parsePermissionValue('a:9:{garbage s:1:"1"}')).toThrow(PhpSerializeError);
  });
});
