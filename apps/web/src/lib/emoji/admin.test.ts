// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMOJI_MAX_BYTES, EMOJI_MAX_EDGE, processEmojiUpload } from "./admin";

/**
 * 表情上传处理（lib/emoji/admin.ts）的单元测试：临时存储目录 + sharp 造图，覆盖全部拒绝分支与成功落盘。
 * 库登记（files + emojis）与审计在 actions 的事务里，由 E2E（admin-emojis.spec）覆盖。
 */
let storage: string;

beforeAll(() => {
  storage = mkdtempSync(join(tmpdir(), "emoji-admin-"));
});

afterAll(() => {
  rmSync(storage, { recursive: true, force: true });
});

const png = async (w: number, h: number): Promise<Buffer> =>
  sharp({
    create: { width: w, height: h, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
  })
    .png()
    .toBuffer();

/**
 * 测试专用：把同一个单帧 GIF 的图像块重复 copies 次，合成一个多帧动图 GIF。
 * 最小实现只认 sharp 输出的形状（Header+LSD+[GCT] 后是若干扩展块（含 GCE）与唯一的 0x2C 图像块）；
 * 扩展块（GCE 作用于紧随的帧）随每帧一起重复。
 */
function makeAnimatedGif(singleFrame: Buffer, copies: number): Buffer {
  const packed = singleFrame[10]!;
  const gctSize = (packed & 0x80) !== 0 ? 3 * 2 ** ((packed & 0x07) + 1) : 0;
  const head = singleFrame.subarray(0, 13 + gctSize);
  // 跳过扩展块（0x21 label + sub-block 链 + 终止 0x00），直到图像描述符 0x2C
  let p = 13 + gctSize;
  while (singleFrame[p] !== 0x2c) {
    if (singleFrame[p] !== 0x21) throw new Error("单帧 GIF 形状与预期不符");
    p += 2;
    while (singleFrame[p] !== 0x00) p += singleFrame[p]! + 1;
    p += 1;
  }
  const exts = singleFrame.subarray(13 + gctSize, p);
  // 图像块 = 0x2C + 描述符(9) + LZW 最小码长(1) + sub-block 链 + 终止 0x00
  const imgStart = p;
  let q = imgStart + 10 + 1; // 先跳过 LZW 最小码长字节，再扫 sub-block 链
  while (singleFrame[q] !== 0x00) q += singleFrame[q]! + 1;
  const img = singleFrame.subarray(imgStart, q + 1);
  // NETSCAPE2.0 循环扩展（动图循环播放的标准写法）
  const loopExt = Buffer.from([
    0x21, 0xff, 0x0b, 0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30, 0x03, 0x01,
    0x00, 0x00, 0x00,
  ]);
  const frame = Buffer.concat([exts, img]);
  return Buffer.concat([
    head,
    loopExt,
    ...Array.from({ length: copies }, () => frame),
    Buffer.from([0x3b]),
  ]);
}

describe("processEmojiUpload", () => {
  it("合法 png：成功落盘，返回内容寻址键与尺寸", async () => {
    const bytes = await png(96, 96);
    const r = await processEmojiUpload(bytes, storage);
    if (!r.ok) throw new Error(`应当成功：${r.message}`);
    expect(r.ext).toBe("png");
    expect(r.mime).toBe("image/png");
    expect(r.width).toBe(96);
    expect(r.height).toBe(96);
    expect(r.storageKey).toMatch(/^..\/..\/[0-9a-f]{64}\.png$/);
    const stored = await import("node:fs/promises").then((fs) =>
      fs.readFile(join(storage, r.storageKey)),
    );
    expect(stored.length).toBe(r.sizeBytes);
  });

  it("gif 全链路：接受、不重编码（字节逐位一致）", async () => {
    const gif = await sharp({ create: { width: 32, height: 32, channels: 3, background: "blue" } })
      .gif()
      .toBuffer();
    const r = await processEmojiUpload(gif, storage);
    if (!r.ok) throw new Error(`应当成功：${r.message}`);
    expect(r.ext).toBe("gif");
    expect(r.sizeBytes).toBe(gif.byteLength);
  });

  it("jpeg / bmp / 未知类型拒收（jpeg 给出可读提示）", async () => {
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } })
      .jpeg()
      .toBuffer();
    const r1 = await processEmojiUpload(jpeg, storage);
    expect(r1).toMatchObject({ ok: false, code: "type" });
    expect(r1.ok === false && r1.message).toContain("PNG / GIF / WebP");
    const r2 = await processEmojiUpload(Buffer.from("not an image at all"), storage);
    expect(r2).toMatchObject({ ok: false, code: "type" });
    expect(await processEmojiUpload(Buffer.alloc(0), storage)).toMatchObject({
      ok: false,
      code: "empty",
    });
  });

  it("超过 200×200 拒收；魔数伪造但不可解码 → undecodable", async () => {
    const big = await png(EMOJI_MAX_EDGE + 1, 64);
    expect(await processEmojiUpload(big, storage)).toMatchObject({ ok: false, code: "size" });
    const tall = await png(64, EMOJI_MAX_EDGE + 1);
    expect(await processEmojiUpload(tall, storage)).toMatchObject({ ok: false, code: "size" });
    // PNG 完整魔数（8 字节头）+ 垃圾：嗅探通过（信魔数），解码失败
    const fake = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("garbage"),
    ]);
    expect(await processEmojiUpload(fake, storage)).toMatchObject({
      ok: false,
      code: "undecodable",
    });
  });

  it("尺寸合规但字节超限拒收（真实场景：GIF 不重编码，多帧动图超 200KB）", async () => {
    // 静态图物理上限 200×200 RGBA raw ≈ 160KB < 200KB，bytes 分支只有动图可达：
    // 用最小合并器把 190×190 噪声单帧 GIF 的图像块重复 8 次（≈280KB，尺寸仍合规）
    const edge = EMOJI_MAX_EDGE - 10;
    const noise = Buffer.alloc(edge * edge * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 31 + ((i * i) % 251)) & 0xff;
    const single = await sharp(noise, { raw: { width: edge, height: edge, channels: 3 } })
      .gif()
      .toBuffer();
    const gif = makeAnimatedGif(single, 8);
    // 自检：合并产物必须是合法动图（sharp 读回帧数 = 8；animated 读法的 height 是各帧堆叠总高，单帧尺寸用 pages:1 读）
    const meta = await sharp(gif, { animated: true }).metadata();
    expect(meta.pages).toBe(8);
    const singleMeta = await sharp(gif, { pages: 1 }).metadata();
    expect(singleMeta.width!).toBeLessThanOrEqual(EMOJI_MAX_EDGE);
    expect(singleMeta.height!).toBeLessThanOrEqual(EMOJI_MAX_EDGE);
    if (gif.byteLength <= EMOJI_MAX_BYTES) throw new Error("测试动图应当大于 200KB");
    const r = await processEmojiUpload(gif, storage);
    expect(r).toMatchObject({ ok: false, code: "bytes" });
  });
});
