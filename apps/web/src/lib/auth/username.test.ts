import { describe, expect, it } from "vitest";
import {
  RESERVED_ASCII,
  RESERVED_CJK,
  USERNAME_FORMAT_MESSAGE,
  USERNAME_RESERVED_MESSAGE,
  checkUsername,
} from "./username";

const reason = (s: string) => {
  const r = checkUsername(s);
  return r.ok ? "ok" : r.reason;
};

describe("格式", () => {
  it("合法：中文 / 字母 / 数字 / 下划线，2–20 位，边界长度通过", () => {
    for (const n of ["小明", "Alice_99", "ab", "a".repeat(20), "字幕组成员", "a1_b2"])
      expect(reason(n), n).toBe("ok");
  });

  it("太短 / 太长 / 空 / 纯空白 → format", () => {
    for (const n of ["a", "", "   ", "a".repeat(21), "字".repeat(21)])
      expect(reason(n), JSON.stringify(n)).toBe("format");
  });

  it("空格、连字符、点、@、emoji、全角、假名、零宽字符、RTL 控制符、同形字符（西里尔 а）都不是合法字符", () => {
    for (const n of [
      "a b",
      "a-b",
      "a.b",
      "a@b",
      "a😀",
      "ａｄｍｉｎ", // 全角
      "さくら",
      "ab​cd", // 零宽空格
      "ab‮cd", // RTL override
      "ab\u0000cd",
      "аdmin", // 西里尔 а + dmin
    ])
      expect(reason(n), JSON.stringify(n)).toBe("format");
  });

  it("前后空白先 trim（与注册 Action 的处理一致）", () => {
    expect(reason("  小明  ")).toBe("ok");
  });

  it("格式错误的提示文案固定", () => {
    expect(checkUsername("a")).toEqual({
      ok: false,
      reason: "format",
      message: USERNAME_FORMAT_MESSAGE,
    });
  });
});

describe("保留名 · ASCII 词（忽略大小写，忽略夹带的数字与下划线）", () => {
  it("词表里的每个词本身都被拦截（词表自身没有写错）", () => {
    for (const w of RESERVED_ASCII) {
      if (w.length >= 2) expect(reason(w), w).toBe("reserved");
    }
  });

  it("大小写变体、夹带数字 / 下划线都算同一个词", () => {
    for (const n of [
      "Admin",
      "ADMIN",
      "AdMiN",
      "admin2",
      "admin_",
      "_admin_",
      "ad_min",
      "a_d_m_i_n",
      "root123",
      "Moderator_01",
      "QingYiSub",
    ])
      expect(reason(n), n).toBe("reserved");
  });

  it("对照：只是包含这些词的正常名字不被拦（ASCII 词只做精确匹配，不做包含）", () => {
    for (const n of ["adminton", "sadmin", "roots", "myroot", "systematic", "modern", "staffan"])
      expect(reason(n), n).toBe("ok");
  });

  it("保留名的提示文案固定，且不透露具体命中了哪个词", () => {
    expect(checkUsername("admin")).toEqual({
      ok: false,
      reason: "reserved",
      message: USERNAME_RESERVED_MESSAGE,
    });
  });
});

describe("保留名 · 中文词（包含即拦）", () => {
  it("词表里的每个词本身，以及出现在任意位置，都被拦截", () => {
    for (const w of RESERVED_CJK) {
      expect(reason(w), w).toBe("reserved");
      expect(reason(`青翼${w}`), `青翼${w}`).toBe("reserved");
      expect(reason(`${w}小王`), `${w}小王`).toBe("reserved");
    }
  });

  it("迁移占位账号的变体：已注销用户5 被拦（已注销用户#5 本来就因 # 不合法）", () => {
    expect(reason("已注销用户5")).toBe("reserved");
    expect(reason("已注销用户#5")).toBe("format");
  });

  it("对照：不含这些词的正常中文名通过（含相近但不同的词）", () => {
    for (const n of ["小明", "字幕组成员", "翻译君", "管理", "版面", "官网", "客人", "站点"])
      expect(reason(n), n).toBe("ok");
  });

  it("已知取舍：含“系统”二字的正常昵称会被误拦（改个名即可）", () => {
    expect(reason("操作系统爱好者")).toBe("reserved");
  });
});
