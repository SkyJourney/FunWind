import { describe, expect, it } from "vitest";
import { flashText } from "./flash";

describe("flashText / flashOk（M19 Q5 回执键统一）", () => {
  const TABLE = { saved: "已保存。", created: "已创建。", "0": "零号键。" };

  it("flashText：表内键出文案，未知键回落 fallback，undefined 无值", () => {
    expect(flashText(TABLE, "saved")).toBe("已保存。");
    expect(flashText(TABLE, "nope", "操作失败")).toBe("操作失败");
    expect(flashText(TABLE, "nope")).toBeUndefined();
    expect(flashText(TABLE, undefined)).toBeUndefined();
  });

  it("flashText：原型属性名不当文案（防原型污染）", () => {
    expect(flashText(TABLE, "toString", "兜底")).toBe("兜底");
    expect(flashText(TABLE, "constructor", "兜底")).toBe("兜底");
  });

  it("flashText：空串码仍按表内自有键处理（空值语义由调用方定）", () => {
    expect(flashText({ "": "空码" }, "", "兜底")).toBe("空码");
  });
});
