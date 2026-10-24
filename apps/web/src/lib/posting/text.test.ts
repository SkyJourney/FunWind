import { describe, expect, it } from "vitest";
import {
  charLength,
  checkBody,
  checkReason,
  checkTitle,
  normalizeBody,
  normalizeTitle,
} from "./text";

describe("normalizeTitle", () => {
  it("trim、折叠连续空白（含换行、制表、NBSP、全角空格）", () => {
    expect(normalizeTitle("  你好   世界 ")).toBe("你好 世界");
    expect(normalizeTitle("a\n\n b\tc d　e")).toBe("a b c d e");
  });

  it("剔除零宽字符、RTL / 双向控制符、BOM、控制字符", () => {
    expect(normalizeTitle("ad​min")).toBe("admin"); // 零宽空格
    expect(normalizeTitle("ab‮cd")).toBe("abcd"); // RTL 覆盖
    expect(normalizeTitle("﻿ab⁦c⁩d")).toBe("abcd");
    expect(normalizeTitle("a\u0000b\u007fc\u0085d")).toBe("abcd");
  });

  it("剔除不可见字符后两侧的空白不会相连成双空格", () => {
    expect(normalizeTitle("a ​ b")).toBe("a b");
  });

  it("看起来一样的标题规范化后相同（抗零宽伪装），不同的仍然不同（对照）", () => {
    expect(normalizeTitle("【字幕】第1话")).toBe(normalizeTitle("【字幕】​第1话"));
    expect(normalizeTitle("第1话")).not.toBe(normalizeTitle("第2话"));
  });

  it("幂等", () => {
    const once = normalizeTitle(" a​ \n b ");
    expect(normalizeTitle(once)).toBe(once);
  });

  it("已知取舍：零宽连接符会拆开 emoji 组合序列", () => {
    expect(normalizeTitle("👨‍👩")).toBe("👨👩");
  });
});

describe("字符计长按码点", () => {
  it("生僻字 / emoji 算一个字符，不是两个 UTF-16 单元", () => {
    expect(charLength("𠮷")).toBe(1);
    expect(charLength("😀😀")).toBe(2);
    expect("𠮷".length).toBe(2); // 对照
  });
});

describe("checkTitle", () => {
  it("合法：返回规范化后的标题；刚好等于上限通过，多一个字符失败", () => {
    expect(checkTitle("  标题  ", 10)).toEqual({ ok: true, value: "标题" });
    expect(checkTitle("a".repeat(100), 100).ok).toBe(true);
    expect(checkTitle("a".repeat(101), 100)).toMatchObject({ ok: false, code: "title_too_long" });
  });

  it("空 / 纯空白 / 只有不可见字符 → title_empty", () => {
    for (const t of ["", "   ", "\n\t", "​​", "‮"])
      expect(checkTitle(t, 100), JSON.stringify(t)).toMatchObject({
        ok: false,
        code: "title_empty",
      });
  });

  it("长度按规范化后的码点算：折叠空白后才超限 / 不超限", () => {
    expect(checkTitle(`a${" ".repeat(50)}b`, 3).ok).toBe(true); // 折叠成 "a b"
    expect(checkTitle("𠮷".repeat(5), 5).ok).toBe(true); // 码点 5，UTF-16 单元 10
  });
});

describe("normalizeBody / checkBody", () => {
  it("统一换行；去掉 NUL 等控制字符但保留换行与制表；trim 两端", () => {
    expect(normalizeBody("a\r\nb\rc\n")).toBe("a\nb\nc");
    expect(normalizeBody("a\u0000b\u0007c\td\ne")).toBe("abc\td\ne");
  });

  it("正文里的空白、缩进、零宽字符保持原样（Markdown 里有意义，不像标题那样折叠）", () => {
    expect(normalizeBody("a  b\n\n    code​")).toBe("a  b\n\n    code​");
  });

  it("空 / 纯空白 → body_empty；超限 → body_too_long；刚好等于上限通过", () => {
    expect(checkBody("  \n ", 10)).toMatchObject({ ok: false, code: "body_empty" });
    expect(checkBody("a".repeat(10), 10).ok).toBe(true);
    expect(checkBody("a".repeat(11), 10)).toMatchObject({ ok: false, code: "body_too_long" });
  });

  it("上限包含门控隐藏正文：把长文塞进 :::gate 不能绕过", () => {
    const src = `公开\n\n:::gate{key="a1" unlock="points" price="1"}\n${"隐".repeat(50)}\n:::`;
    expect(checkBody(src, 40)).toMatchObject({ ok: false, code: "body_too_long" });
    expect(checkBody(src, 1000).ok).toBe(true);
  });
});

describe("checkReason", () => {
  it("trim 后非空；去控制字符；超限失败；边界通过", () => {
    expect(checkReason("  广告  ")).toEqual({ ok: true, value: "广告" });
    expect(checkReason("")).toMatchObject({ ok: false, code: "reason_required" });
    expect(checkReason("​ \n")).toMatchObject({ ok: false, code: "reason_required" });
    expect(checkReason("a".repeat(200)).ok).toBe(true);
    expect(checkReason("a".repeat(201))).toMatchObject({ ok: false, code: "reason_too_long" });
  });
});
