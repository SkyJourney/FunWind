import { describe, expect, it } from "vitest";
import { attachmentsField } from "./attachments-field";

/**
 * 表单 attachments 字段解析（M6.4d1；M9.5 补覆盖）：三态语义与结构校验的全分支。
 */
describe("attachmentsField", () => {
  it("字段缺失 → undefined（服务端不改动已有附件）", () => {
    expect(attachmentsField.parse(undefined)).toBeUndefined();
  });

  it("空字符串或 [] → 明确清空（空数组）", () => {
    expect(attachmentsField.parse("")).toEqual([]);
    expect(attachmentsField.parse("  ")).toEqual([]);
    expect(attachmentsField.parse("[]")).toEqual([]);
  });

  it("非法 JSON → 结构校验失败（抛错，不是静默清空）", () => {
    expect(() => attachmentsField.parse("{not json")).toThrow();
  });

  it("合法数组：通过并保留 gateKey 的 null/字符串两态", () => {
    const ok = [
      { fileId: 12, gateKey: null, name: "字幕包.zip" },
      { fileId: 13, gateKey: "g1", name: "门控附件.zip" },
    ];
    expect(attachmentsField.parse(JSON.stringify(ok))).toEqual(ok);
  });

  it("结构不符 / 超过单帖上限 → 拒绝", () => {
    expect(() =>
      attachmentsField.parse(JSON.stringify([{ fileId: -1, gateKey: null, name: "x" }])),
    ).toThrow();
    expect(() =>
      attachmentsField.parse(
        JSON.stringify(
          Array.from({ length: 21 }, (_, i) => ({ fileId: i + 1, gateKey: null, name: `f${i}` })),
        ),
      ),
    ).toThrow();
  });
});
