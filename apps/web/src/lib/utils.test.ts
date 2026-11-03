import { describe, expect, it } from "vitest";
import { cn, positiveIntParam } from "./utils";

describe("positiveIntParam", () => {
  it.each([
    ["01", 1],
    ["+1", 1],
    ["1e2", 100],
    ["0x10", 16],
    ["1.0", 1],
    [" 12 ", 12],
    ["0b10", 2],
    ["0o10", 8],
    ["9007199254740992", 9007199254740992],
    [null, null],
    [undefined, null],
    ["", null],
    [" ", null],
    ["bad", null],
    ["1.5", null],
    ["0", null],
    ["-1", null],
    ["Infinity", null],
    ["-Infinity", null],
    ["NaN", null],
    ["1e309", null],
    ["1_000", null],
    ["1abc", null],
  ] as const)("%s 保留 Number 正整数的原接受面", (raw, expected) => {
    expect(positiveIntParam(raw)).toBe(expected);
  });

  it("性质：多种数字写法与脏前后缀的生成样本均与旧页面/stream 解析等价", () => {
    const samples: (string | null | undefined)[] = [null, undefined, "", "bad", "Infinity"];
    for (let i = -128; i <= 512; i++) {
      samples.push(String(i), ` ${i} `, `${i}.0`, `${i}.5`, `${i}e2`, `${i}x`, `x${i}`);
      if (i >= 0) samples.push(`+${i}`, `0${i}`, `0x${i.toString(16)}`);
    }
    for (const raw of samples) {
      const n = Number(raw);
      const oldPage = Number.isInteger(n) && n > 0 ? n : null;
      const oldStream =
        raw === null || raw === undefined || raw === ""
          ? undefined
          : Number.isInteger(n) && n > 0
            ? n
            : undefined;
      expect(positiveIntParam(raw), String(raw)).toBe(oldPage);
      expect(positiveIntParam(raw) ?? undefined, String(raw)).toBe(oldStream);
    }
  });
});

describe("cn", () => {
  it("拼接多个类名", () => {
    expect(cn("a", "b")).toBe("a b");
  });

  it("过滤假值（条件类名）", () => {
    expect(cn("a", false && "b", undefined, null, "c")).toBe("a c");
  });

  it("tailwind-merge 去冲突：后者覆盖前者", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
    expect(cn("text-sm", "text-lg")).toBe("text-lg");
  });

  it("不冲突的类名共存", () => {
    expect(cn("px-2", "py-2")).toBe("px-2 py-2");
  });
});
