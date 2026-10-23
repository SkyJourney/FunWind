import { describe, expect, it } from "vitest";
import { contentDispositionFor, resolveStaticPath } from "./static-files";

const BASE = "/data/attachment";

describe("resolveStaticPath（路径穿越守卫）", () => {
  it("正常相对段解析到 baseDir 下", () => {
    expect(resolveStaticPath(BASE, ["Mon_1004", "55_7_a.jpg"])).toBe(
      "/data/attachment/Mon_1004/55_7_a.jpg",
    );
  });

  it("拒绝 ../ 穿越（含嵌在中间）", () => {
    expect(resolveStaticPath(BASE, [".."])).toBeNull();
    expect(resolveStaticPath(BASE, ["Mon_1004", "..", "x.jpg"])).toBeNull();
    expect(resolveStaticPath(BASE, ["Mon_1004", "..%2F..", "x.jpg"])).toBeNull();
  });

  it("拒绝段内路径分隔符（/ 与 \\）", () => {
    expect(resolveStaticPath(BASE, ["Mon_1004/x.jpg"])).toBeNull();
    expect(resolveStaticPath(BASE, ["..\\windows\\x.jpg"])).toBeNull();
  });

  it("拒绝空段与点段", () => {
    expect(resolveStaticPath(BASE, [])).toBeNull();
    expect(resolveStaticPath(BASE, [""])).toBeNull();
    expect(resolveStaticPath(BASE, ["."])).toBeNull();
    expect(resolveStaticPath(BASE, ["..."])).toBeNull();
  });

  it("拒绝 NUL 与越界绝对路径", () => {
    expect(resolveStaticPath(BASE, ["a\0b"])).toBeNull();
    expect(resolveStaticPath(BASE, ["/etc/passwd"])).toBeNull();
  });

  it("中文与常见文件名字符放行", () => {
    expect(resolveStaticPath(BASE, ["字幕组", "字幕 (1).rar"])).toBe(
      "/data/attachment/字幕组/字幕 (1).rar",
    );
  });
});

describe("contentDispositionFor", () => {
  it("图片/文本/种子按类型内联或下载", () => {
    expect(contentDispositionFor("a.jpg")).toEqual({ type: "image/jpeg", inline: true });
    expect(contentDispositionFor("b.gif")).toEqual({ type: "image/gif", inline: true });
    expect(contentDispositionFor("c.txt")).toMatchObject({ inline: true });
    expect(contentDispositionFor("d.torrent").inline).toBe(false);
  });

  it("rar/zip/未知扩展按二进制附件下载", () => {
    expect(contentDispositionFor("e.rar")).toEqual({
      type: "application/vnd.rar",
      inline: false,
    });
    expect(contentDispositionFor("f.unknown")).toEqual({
      type: "application/octet-stream",
      inline: false,
    });
  });
});
