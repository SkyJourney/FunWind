// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseBearerToken } from "./guard";

describe("Bearer 解析（M20 门禁第一环）", () => {
  /** 合法明文样例：fw_at_ + 43 字符 base64url */
  const PLAIN = `fw_at_${"a".repeat(43)}`;

  it("合法形态放行", () => {
    expect(parseBearerToken(`Bearer ${PLAIN}`)).toBe(PLAIN);
    // base64url 字符集（-、_、大小写、数字）逐类抽验
    expect(parseBearerToken(`Bearer fw_at_Ab09-_${"x".repeat(37)}`)).toBe(
      `fw_at_Ab09-_${"x".repeat(37)}`,
    );
  });

  it("新版接受细粒度令牌，但 M20 解析器不会接受同一凭证", () => {
    const scoped = `fw_at2_${"a".repeat(43)}`;
    const oldParser = /^Bearer fw_at_[A-Za-z0-9_-]{43}$/;
    expect(parseBearerToken(`Bearer ${scoped}`)).toBe(scoped);
    expect(oldParser.test(`Bearer ${scoped}`)).toBe(false);
    expect(oldParser.test(`Bearer ${PLAIN}`)).toBe(true);
    expect(parseBearerToken(`Bearer ${scoped}\n`)).toBeNull();
  });

  it("缺头 / 空串 / 非 Bearer 模式一律拒绝", () => {
    expect(parseBearerToken(null)).toBeNull();
    expect(parseBearerToken("")).toBeNull();
    expect(parseBearerToken("Bearer")).toBeNull();
    expect(parseBearerToken("bearer fw_at_x")).toBeNull(); // scheme 大小写敏感
    expect(parseBearerToken(`Basic ${PLAIN}`)).toBeNull();
    expect(parseBearerToken(`Bearer  ${PLAIN}`)).toBeNull(); // 多余空格
    expect(parseBearerToken(`Bearer ${PLAIN} extra`)).toBeNull();
  });

  it("前缀不符 / 长度不符 / 字符集不符一律拒绝（存在性不泄露）", () => {
    expect(parseBearerToken(`Bearer xx_at_${"a".repeat(43)}`)).toBeNull();
    expect(parseBearerToken(`Bearer fw_at_${"a".repeat(42)}`)).toBeNull();
    expect(parseBearerToken(`Bearer fw_at_${"a".repeat(44)}`)).toBeNull();
    // base64 标准字符 + / 与 = 不属于 base64url，拒绝
    expect(parseBearerToken(`Bearer fw_at_${"a".repeat(41)}+/=`)).toBeNull();
    // 中文等非 ASCII 拒绝
    expect(parseBearerToken(`Bearer fw_at_${"中".repeat(43)}`)).toBeNull();
  });
});
