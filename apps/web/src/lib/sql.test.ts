// @vitest-environment node
import { describe, expect, it } from "vitest";
import { escapeLike } from "./sql";

/**
 * escapeLike 直接单测（审查 A-P2-6）：此前仅经 rum/queries 集成间接覆盖 %，
 * _ 与 \ 的转义没有直接锚。这里钉死三类通配符都被转义、普通字符不变。
 */
describe("escapeLike（LIKE 通配符转义）", () => {
  it("三类通配符 % _ \\ 各自转义", () => {
    expect(escapeLike("100%")).toBe("100\\%");
    expect(escapeLike("a_b")).toBe("a\\_b");
    expect(escapeLike("a\\b")).toBe("a\\\\b");
  });

  it("混合与多次出现都逐个转义", () => {
    expect(escapeLike("%_\\")).toBe("\\%\\_\\\\");
    expect(escapeLike("%%__")).toBe("\\%\\%\\_\\_");
  });

  it("普通字符与空串不变", () => {
    expect(escapeLike("/admin/themes")).toBe("/admin/themes");
    expect(escapeLike("")).toBe("");
  });
});
