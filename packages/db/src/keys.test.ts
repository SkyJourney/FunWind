import { describe, expect, it } from "vitest";
import { normalizeKey } from "./keys.js";

describe("normalizeKey", () => {
  it("trim + 小写；假名各自独立，半角不被 NFKC 合并", () => {
    expect(normalizeKey("  Alice ")).toBe("alice");
    expect(normalizeKey("A@X.io")).toBe("a@x.io");
    expect(normalizeKey("さくら")).not.toBe(normalizeKey("サクラ"));
    expect(normalizeKey("ｻｸﾗ")).not.toBe(normalizeKey("サクラ"));
  });
});
