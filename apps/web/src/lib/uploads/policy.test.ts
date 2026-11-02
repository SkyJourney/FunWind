// @vitest-environment node
import { describe, expect, it } from "vitest";
import { admit, extensionOf, parseFileKey, sanitizeOriginalName, storageKeyFor } from "./policy";

describe("admit 准入规则", () => {
  it("扩展名与嗅探类型一致、用途允许 → 通过", () => {
    expect(admit("a.jpg", "inline", "jpeg")).toEqual({ ok: true });
    expect(admit("a.JPEG", "inline", "jpeg")).toEqual({ ok: true });
    expect(admit("字幕包.zip", "attachment", "zip")).toEqual({ ok: true });
  });

  it("伪装：php 内容改名为 .jpg（嗅探为 txt）→ type_mismatch", () => {
    expect(admit("x.jpg", "inline", "txt")).toEqual({ ok: false, code: "type_mismatch" });
  });

  it("白名单外的扩展名（svg / html / js）一律拒绝", () => {
    for (const name of ["a.svg", "a.html", "a.js", "a.php"]) {
      expect(admit(name, "attachment", "txt")).toEqual({
        ok: false,
        code: "extension_not_allowed",
      });
    }
  });

  it("没有扩展名 → no_extension", () => {
    expect(admit("README", "attachment", "txt")).toEqual({ ok: false, code: "no_extension" });
    expect(admit(".hidden", "attachment", "txt")).toEqual({ ok: false, code: "no_extension" });
  });

  it("用途限制：inline / avatar 只收图片，附件可收压缩包", () => {
    expect(admit("a.zip", "inline", "zip")).toEqual({ ok: false, code: "purpose_type" });
    expect(admit("a.txt", "avatar", "txt")).toEqual({ ok: false, code: "purpose_type" });
    expect(admit("a.zip", "attachment", "zip")).toEqual({ ok: true });
  });
});

describe("extensionOf / sanitizeOriginalName / storageKeyFor", () => {
  it("extensionOf 取最后一个点之后的小写部分，忽略路径", () => {
    expect(extensionOf("dir/sub\\A.TAR.GZ")).toBe("gz");
    expect(extensionOf("noext")).toBeNull();
  });

  it("文件名清洗：去路径、控制字符、空白，截断；空名退化为 download", () => {
    expect(sanitizeOriginalName("../../etc/passwd.txt")).toBe("passwd.txt");
    expect(sanitizeOriginalName("a\u0000\u0007b .zip ")).toBe("ab .zip");
    expect(sanitizeOriginalName("   ")).toBe("download");
    expect(sanitizeOriginalName("字".repeat(300))).toHaveLength(255);
  });

  it("存储键：ab/cd/<sha>.<存储扩展名>，扩展名取嗅探结果", () => {
    const sha = "ab" + "cd".repeat(31) + "ef";
    expect(storageKeyFor(sha, "jpeg")).toBe(`ab/cd/${sha}.jpg`);
    expect(storageKeyFor(sha, "7z")).toBe(`ab/cd/${sha}.7z`);
  });
});

describe("parseFileKey 内容寻址键校验", () => {
  const SHA = "a".repeat(64);

  it('段内带 "/"（%2f 被 Next 解码进段）的别名形态一律拒绝——同一文件只能有一个 URL（M5.6 S4）', () => {
    const key = `aa/aa/${SHA}.png`;
    expect(parseFileKey(["aa", "aa", `${SHA}.png`])).toBe(key); // 对照：规范三段形态通过
    for (const alias of [
      ["aa/aa", `${SHA}.png`], // 两段：/files/aa%2faa/<sha>.png
      ["aa/aa/" + `${SHA}.png`], // 一段：全部 %2f
      ["aa", `aa/${SHA}.png`], // 仅最后一个 %2f
      ["aa/", "aa", `${SHA}.png`], // 三段但段内含斜杠
    ]) {
      expect(parseFileKey(alias), JSON.stringify(alias)).toBeNull();
    }
  });

  it("只接受 ab/cd/<64位小写hex>.<ext>，且目录必须等于哈希前缀", () => {
    expect(parseFileKey(["aa", "aa", `${SHA}.png`])).toBe(`aa/aa/${SHA}.png`);
    for (const bad of [
      ["aa", "aa", `${SHA}`], // 无扩展名
      ["aa", "bb", `${SHA}.png`], // 目录与哈希前缀不符
      ["AA", "AA", `${"A".repeat(64)}.png`], // 大写
      ["aa", "aa", `${"a".repeat(63)}.png`], // 哈希过短
      ["aa", "aa", `${SHA}.png`, "x"], // 多余段
      ["..", "aa", `${SHA}.png`],
      ["aa", "aa", `${SHA}.p/ng`],
      ["aa", "aa", `${SHA}.${"x".repeat(9)}`], // 扩展名过长
      [],
    ]) {
      expect(parseFileKey(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});
