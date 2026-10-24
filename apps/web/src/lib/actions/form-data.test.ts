import { describe, expect, it } from "vitest";
import { formDataToObject } from "./form-data";

const fd = (entries: [string, string | Blob][]) => {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
};

describe("formDataToObject", () => {
  it("单值保持字符串；空字符串原样保留（不当成缺失）", () => {
    expect(
      formDataToObject(
        fd([
          ["a", "1"],
          ["b", ""],
        ]),
      ),
    ).toEqual({ a: "1", b: "" });
  });

  it("同名多值归并为数组，顺序保持；两个、三个都正确", () => {
    expect(
      formDataToObject(
        fd([
          ["t", "x"],
          ["t", "y"],
        ]),
      ),
    ).toEqual({ t: ["x", "y"] });
    expect(
      formDataToObject(
        fd([
          ["t", "x"],
          ["t", "y"],
          ["t", "z"],
        ]),
      ),
    ).toEqual({
      t: ["x", "y", "z"],
    });
  });

  it("文件字段一律忽略（Server Action 不接文件，上传走专门的 route handler）；对照：同名的字符串字段仍保留", () => {
    const file = new File(["data"], "a.png", { type: "image/png" });
    expect(
      formDataToObject(
        fd([
          ["upload", file],
          ["note", "hi"],
        ]),
      ),
    ).toEqual({ note: "hi" });
    expect(
      formDataToObject(
        fd([
          ["x", file],
          ["x", "s"],
        ]),
      ),
    ).toEqual({ x: "s" });
  });

  it("原型污染：__proto__ / constructor / prototype 字段被丢弃，结果是空原型对象，全局 Object 不受影响", () => {
    const out = formDataToObject(
      fd([
        ["__proto__", "polluted"],
        ["constructor", "c"],
        ["prototype", "p"],
        ["ok", "1"],
      ]),
    );
    expect(out).toEqual({ ok: "1" });
    expect(Object.getPrototypeOf(out)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(out)).toEqual(["ok"]);
  });

  it("空表单得到空对象", () => {
    expect(formDataToObject(new FormData())).toEqual({});
  });
});
