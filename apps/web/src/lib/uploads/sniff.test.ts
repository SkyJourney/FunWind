// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isPlainText, sniffType } from "./sniff";

const buf = (...parts: (string | number[])[]) =>
  Buffer.from(parts.flatMap((p) => (typeof p === "string" ? [...Buffer.from(p, "latin1")] : p)));

describe("sniffType 魔数", () => {
  it("图片：jpeg / png / gif / webp", () => {
    expect(sniffType(buf([0xff, 0xd8, 0xff, 0xe0], "JFIF"))).toBe("jpeg");
    expect(sniffType(buf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("png");
    expect(sniffType(buf("GIF89a..."))).toBe("gif");
    expect(sniffType(buf("RIFF", [0, 0, 0, 0], "WEBPVP8 "))).toBe("webp");
  });

  it("压缩包与种子", () => {
    expect(sniffType(buf([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toBe("zip");
    expect(sniffType(buf([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]))).toBe("rar");
    expect(sniffType(buf([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]))).toBe("7z");
    expect(sniffType(buf("d8:announce3:url4:infod6:lengthi1eee"))).toBe("torrent");
  });

  it("BMP：需要文件总长与保留字段都对得上", () => {
    const bmp = Buffer.alloc(30);
    bmp.write("BM", 0, "latin1");
    bmp.writeUInt32LE(30, 2);
    expect(sniffType(bmp)).toBe("bmp");
    // 以 BM 开头的普通文本不是 BMP
    expect(sniffType(Buffer.from("BM 这是一段文字，不是位图。\n"))).toBe("txt");
  });

  it("纯文本：无 NUL 且为有效 UTF-8", () => {
    expect(sniffType(Buffer.from("字幕文件\n00:00:01,000 --> 00:00:02,000\n"))).toBe("txt");
    expect(isPlainText(Buffer.from([0x61, 0x00, 0x62]))).toBe(false);
    expect(isPlainText(Buffer.from([0xff, 0xfe, 0xfd]))).toBe(false);
    expect(isPlainText(Buffer.alloc(0))).toBe(false);
  });

  it("未知二进制返回 null", () => {
    expect(sniffType(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00]))).toBeNull();
  });

  it("伪装：PHP 源码按文本识别（扩展名是否一致由 policy 判定）", () => {
    expect(sniffType(Buffer.from("<?php system($_GET['c']); ?>"))).toBe("txt");
  });
});
