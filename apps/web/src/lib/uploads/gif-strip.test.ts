// @vitest-environment node
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { ProcessError, stripGifAncillary } from "./process-image";

/** 1×1 的最小 GIF：头部 + 全局色表 + 图形控制 + 图像块 + 结束符（与常见的 1×1 GIF 字节一致） */
const HEAD = "474946383961" + "01000100800000" + "ffffff000000";
const GCE = "21f90401000000" + "00";
const IMAGE = "2c00000000010001000002" + "02440100"; // 图像块：描述符 + LZW 最小码长 02 + 子块 44 01 + 结束
const TRAILER = "3b";
const COMMENT = "21fe05" + "68656c6c6f" + "00"; // 注释块 "hello"
const XMP = "21ff0b" + "584d502044617461584d50" + "026162" + "00"; // XMP 应用扩展（11 字节标识 "XMP DataXMP"）
const NETSCAPE = "21ff0b" + "4e4554534341504532" + "2e30" + "03" + "010000" + "00"; // 循环信息 NETSCAPE2.0（子块 3 字节 + 结束），保留

const gif = (...parts: string[]) => Buffer.from(parts.join(""), "hex");

describe("stripGifAncillary：去除注释与非动画的应用扩展", () => {
  it("注释块与 XMP 被去除；循环信息、图形控制与图像数据保留，输出仍可解码", async () => {
    const dirty = gif(HEAD, COMMENT, XMP, NETSCAPE, GCE, IMAGE, TRAILER);
    const clean = stripGifAncillary(dirty);
    expect(clean.includes(Buffer.from("hello"))).toBe(false);
    expect(clean.includes(Buffer.from("XMP DataXMP"))).toBe(false);
    expect(clean.includes(Buffer.from("NETSCAPE2.0"))).toBe(true);
    expect(clean.length).toBe(dirty.length - COMMENT.length / 2 - XMP.length / 2);
    const meta = await sharp(clean).metadata();
    expect(meta).toMatchObject({ format: "gif", width: 1, height: 1 });
  });

  it("结构被截断时拒绝（不做尽力而为的截取）", () => {
    const truncated = gif(HEAD, COMMENT, GCE.slice(0, 6));
    expect(() => stripGifAncillary(truncated)).toThrow(ProcessError);
  });
});
