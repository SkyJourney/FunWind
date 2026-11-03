// @vitest-environment node
/**
 * 图片处理的真实 sharp 测试：夹具全部在测试内现生成，不依赖外部图片。
 * 覆盖：EXIF 定向与尺寸对调、EXIF/GPS 剥离、裁剪坐标系（已定向）、像素上限、解码失败、GIF 不重编码、头像。
 */
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { processImage, stripGifAncillary } from "./process-image";

const solid = (w: number, h: number, ch: 3 | 4 = 3) =>
  sharp({
    create: { width: w, height: h, channels: ch, background: { r: 200, g: 40, b: 40, alpha: 1 } },
  });

/** 80×40 原始像素、EXIF 方向 6（显示时需顺时针旋转 90°，显示尺寸 40×80）、带 EXIF 描述字段的 JPEG */
const rotatedJpeg = () =>
  solid(80, 40)
    .jpeg()
    .withMetadata({ orientation: 6, exif: { IFD0: { ImageDescription: "private note" } } })
    .toBuffer();

/** 最小 24 位 BMP：2×2 像素（行宽按 4 字节对齐，共 70 字节） */
function tinyBmp(): Buffer {
  const b = Buffer.alloc(70);
  b.write("BM", 0, "latin1");
  b.writeUInt32LE(70, 2);
  b.writeUInt32LE(54, 10); // 像素数据偏移
  b.writeUInt32LE(40, 14); // DIB 头长度
  b.writeInt32LE(2, 18); // 宽
  b.writeInt32LE(2, 22); // 高
  b.writeUInt16LE(1, 26); // 色彩面
  b.writeUInt16LE(24, 28); // 位深
  b.writeUInt32LE(16, 34); // 像素数据长度
  return b;
}

describe("processImage：定向与元数据", () => {
  it("EXIF 方向 6：输出尺寸对调为 40×80，且输出不含 EXIF", async () => {
    const input = await rotatedJpeg();
    expect((await sharp(input).metadata()).orientation).toBe(6);
    const out = await processImage(input, { sniffed: "jpeg" });
    expect(out.sniffed).toBe("jpeg");
    expect(out.mime).toBe("image/jpeg");
    expect([out.width, out.height]).toEqual([40, 80]);
    const meta = await sharp(out.bytes).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation === undefined || meta.orientation === 1).toBe(true);
  });

  it("png 与 webp 保持原格式", async () => {
    const png = await solid(20, 20).png().toBuffer();
    expect((await processImage(png, { sniffed: "png" })).sniffed).toBe("png");
    const webp = await solid(20, 20).webp().toBuffer();
    expect((await processImage(webp, { sniffed: "webp" })).sniffed).toBe("webp");
  });

  it("BMP：当前 sharp 构建无法解码，必须以 undecodable 明确拒绝（不放行未经解码的字节）", async () => {
    await expect(processImage(tinyBmp(), { sniffed: "bmp" })).rejects.toMatchObject({
      code: "undecodable",
    });
  });
});

describe("processImage：裁剪（已定向的坐标系）", () => {
  it("按定向后的尺寸裁剪：40×80 的区域合法，80×40（原始方向）不合法", async () => {
    const input = await rotatedJpeg();
    const ok = await processImage(input, {
      sniffed: "jpeg",
      crop: { x: 0, y: 0, width: 40, height: 80 },
    });
    expect([ok.width, ok.height]).toEqual([40, 80]);
    await expect(
      processImage(input, { sniffed: "jpeg", crop: { x: 0, y: 0, width: 80, height: 40 } }),
    ).rejects.toMatchObject({ code: "crop_invalid" });
  });

  it("裁剪取到的是定向后的像素：左上角 40×40 与原始左上角在方向 6 下不同区域", async () => {
    // 左半红、右半蓝（原始像素）。方向 6 显示时，左半变成上半
    const right = await sharp({
      create: { width: 40, height: 40, channels: 3, background: "#0000ff" },
    })
      .png()
      .toBuffer();
    const input = await sharp({
      create: { width: 80, height: 40, channels: 3, background: "#ff0000" },
    })
      .composite([{ input: right, left: 40, top: 0 }])
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    // 显示尺寸 40×80：上半 40×40 是原始左半（红色），下半是原始右半（蓝色）
    const top = await processImage(input, {
      sniffed: "jpeg",
      crop: { x: 0, y: 0, width: 40, height: 40 },
    });
    const { data } = await sharp(top.bytes).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(200); // R
    expect(data[2]).toBeLessThan(80); // B
  });

  it("裁剪输出尺寸等于裁剪尺寸", async () => {
    const input = await solid(120, 80).jpeg().toBuffer();
    const out = await processImage(input, {
      sniffed: "jpeg",
      crop: { x: 10, y: 5, width: 50, height: 40 },
    });
    expect([out.width, out.height]).toEqual([50, 40]);
  });
});

describe("processImage：像素上限与解码失败", () => {
  it("超过像素上限 → pixels（上限可覆盖以避免生成大图）", async () => {
    const png = await solid(20, 20).png().toBuffer();
    await expect(processImage(png, { sniffed: "png", maxPixels: 100 })).rejects.toMatchObject({
      code: "pixels",
    });
  });

  it("魔数正确但内容损坏 → undecodable", async () => {
    const fake = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x11)]);
    await expect(processImage(fake, { sniffed: "jpeg" })).rejects.toMatchObject({
      code: "undecodable",
    });
  });
});

/** 两帧、独立延时和有限循环；坏帧只替换 LZW 数据，块边界保持合法。 */
function animatedGif(badFrame?: number): Buffer {
  const head = Buffer.from("47494638396101000100800000ffffff000000", "hex");
  const loop = Buffer.from("21ff0b4e45545343415045322e300301030000", "hex");
  const frames = [10, 20].map((delay, index) =>
    Buffer.from(
      `21f90404${delay.toString(16).padStart(2, "0")}0000002c0000000001000100000202${badFrame === index ? "ffff" : index === 0 ? "4401" : "4c01"}00`,
      "hex",
    ),
  );
  return Buffer.concat([head, loop, ...frames, Buffer.from([0x3b])]);
}

describe("processImage：GIF", () => {
  it("两帧动画完整保留像素、帧数、延时、循环和字节，不退化成首帧", async () => {
    const input = animatedGif();
    const out = await processImage(input, { sniffed: "gif" });
    expect(out.bytes).toEqual(input);
    expect(await sharp(out.bytes, { animated: true }).metadata()).toMatchObject({
      pages: 2,
      pageHeight: 1,
      delay: [100, 200],
      loop: 4,
    });
    const pixels = await sharp(out.bytes, { animated: true }).ensureAlpha().raw().toBuffer();
    expect(pixels).toEqual(await sharp(input, { animated: true }).ensureAlpha().raw().toBuffer());
    expect([...pixels.subarray(0, 3)]).not.toEqual([...pixels.subarray(4, 7)]);
  });

  it.each([0, 1])("第 %s 帧 LZW 损坏但结构完整、metadata 成功时仍拒绝", async (badFrame) => {
    const input = animatedGif(badFrame);
    expect(stripGifAncillary(input)).toEqual(input);
    expect(await sharp(input, { pages: 1 }).metadata()).toMatchObject({
      format: "gif",
      width: 1,
      height: 1,
    });
    await expect(
      sharp(input, { animated: true, failOn: "warning" }).raw().toBuffer(),
    ).rejects.toThrow();
    await expect(processImage(input, { sniffed: "gif" })).rejects.toMatchObject({
      code: "undecodable",
    });
  });

  it("动画总解码像素受上限约束，而不是只计算首帧", async () => {
    const input = animatedGif();
    await expect(processImage(input, { sniffed: "gif", maxPixels: 1 })).rejects.toMatchObject({
      code: "pixels",
    });
    const out = await processImage(input, { sniffed: "gif", maxPixels: 2 });
    expect(out.bytes).toEqual(input);
  });

  it("GIF 头像也拒绝后续坏帧，合法动画仍只输出首帧头像", async () => {
    const out = await processImage(animatedGif(), { sniffed: "gif", avatar: true });
    expect(out).toMatchObject({ sniffed: "webp", width: 240, height: 240 });
    await expect(
      processImage(animatedGif(1), { sniffed: "gif", avatar: true }),
    ).rejects.toMatchObject({ code: "undecodable" });
  });

  it("非头像：原样存储，不重编码（字节完全相同）", async () => {
    const gif = await solid(16, 16).gif().toBuffer();
    const out = await processImage(gif, { sniffed: "gif" });
    expect(out.bytes.equals(gif)).toBe(true);
    expect(out.sniffed).toBe("gif");
    expect([out.width, out.height]).toEqual([16, 16]);
  });

  it("GIF 不允许手动裁剪 → gif_crop", async () => {
    const gif = await solid(16, 16).gif().toBuffer();
    await expect(
      processImage(gif, { sniffed: "gif", crop: { x: 0, y: 0, width: 8, height: 8 } }),
    ).rejects.toMatchObject({ code: "gif_crop" });
  });
});

describe("processImage：头像", () => {
  it("裁剪后输出 240×240 webp", async () => {
    const input = await solid(300, 200).jpeg().toBuffer();
    const out = await processImage(input, {
      sniffed: "jpeg",
      avatar: true,
      crop: { x: 50, y: 0, width: 200, height: 200 },
    });
    expect(out.sniffed).toBe("webp");
    expect([out.width, out.height]).toEqual([240, 240]);
  });

  it("头像必须裁剪，且必须 1:1", async () => {
    const input = await solid(300, 200).jpeg().toBuffer();
    await expect(processImage(input, { sniffed: "jpeg", avatar: true })).rejects.toMatchObject({
      code: "crop_invalid",
    });
    await expect(
      processImage(input, {
        sniffed: "jpeg",
        avatar: true,
        crop: { x: 0, y: 0, width: 200, height: 100 },
      }),
    ).rejects.toMatchObject({ code: "crop_invalid" });
  });

  it("GIF 头像：取首帧居中裁成正方形，输出 240×240 webp（不接受手动裁剪）", async () => {
    const gif = await solid(300, 200).gif().toBuffer();
    const out = await processImage(gif, { sniffed: "gif", avatar: true });
    expect(out.sniffed).toBe("webp");
    expect([out.width, out.height]).toEqual([240, 240]);
    await expect(
      processImage(gif, {
        sniffed: "gif",
        avatar: true,
        crop: { x: 0, y: 0, width: 100, height: 100 },
      }),
    ).rejects.toMatchObject({ code: "gif_crop" });
  });
});
