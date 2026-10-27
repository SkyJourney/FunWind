import { describe, expect, it } from "vitest";
import { formatCode } from "./invites";

/** 邀请码面（M10.6b）：12 位原料 → 4-4-4 展示；字母表去易混字符在 randomCode 内部保证 */
describe("formatCode（M10.6b）", () => {
  it("每 4 位一组以连字符连接", () => {
    expect(formatCode("ABCD2345FGHJ")).toBe("ABCD-2345-FGHJ");
    expect(formatCode("")).toBe("");
  });
});
