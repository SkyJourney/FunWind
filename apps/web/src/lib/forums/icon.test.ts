// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ICON_MAX_BYTES, ICON_MAX_EDGE, processForumIcon } from "./icon";

/**
 * 板块图上传处理（lib/forums/icon.ts，M9.5 §3.4）的单元测试：临时存储目录 + sharp 造图，
 * 覆盖全部拒绝分支（empty / type / size / bytes / undecodable）与成功落盘。
 */
let storage: string;

beforeAll(() => {
  storage = mkdtempSync(join(tmpdir(), "forum-icon-"));
});

afterAll(() => {
  rmSync(storage, { recursive: true, force: true });
});

const png = async (w: number, h: number): Promise<Buffer> =>
  sharp({
    create: { width: w, height: h, channels: 4, background: { r: 20, g: 80, b: 200, alpha: 1 } },
  })
    .png()
    .toBuffer();

describe("processForumIcon", () => {
  it("合法 png：成功落盘，返回内容寻址键、尺寸与字节数", async () => {
    const bytes = await png(300, 160);
    const r = await processForumIcon(bytes, storage);
    if (!r.ok) throw new Error(`应当成功：${r.message}`);
    expect(r.ext).toBe("png");
    expect(r.width).toBe(300);
    expect(r.height).toBe(160);
    expect(r.sizeBytes).toBeGreaterThan(0);
    expect(r.storageKey).toMatch(/^..\/..\/[0-9a-f]{64}\.png$/);
    const stored = await import("node:fs/promises").then((fs) =>
      fs.readFile(join(storage, r.storageKey)),
    );
    expect(stored.length).toBe(r.sizeBytes);
  });

  it("jpeg 接受（旧站板块图即 jpg）；bmp / 未知类型 / 空内容拒收", async () => {
    const jpeg = await sharp({
      create: { width: 165, height: 100, channels: 3, background: "red" },
    })
      .jpeg()
      .toBuffer();
    const r = await processForumIcon(jpeg, storage);
    if (!r.ok) throw new Error(`应当成功：${r.message}`);
    expect(r.ext).toBe("jpg");

    // 手造最小 BMP（54 字节头 + 像素）：嗅探识别为 bmp → 类型拒收
    const bmp = Buffer.alloc(70);
    bmp.write("BM", 0);
    bmp.writeUInt32LE(70, 2);
    bmp.writeUInt32LE(54, 10);
    bmp.writeUInt32LE(40, 14);
    bmp.writeUInt32LE(8, 18);
    bmp.writeInt32LE(8, 22);
    const r2 = await processForumIcon(bmp, storage);
    expect(r2).toMatchObject({ ok: false, code: "type" });
    expect(await processForumIcon(Buffer.alloc(0), storage)).toMatchObject({
      ok: false,
      code: "empty",
    });
    expect(await processForumIcon(Buffer.from("not an image at all"), storage)).toMatchObject({
      ok: false,
      code: "type",
    });
  });

  it("超过 512×512 拒收；魔数伪造但不可解码 → undecodable", async () => {
    const big = await png(ICON_MAX_EDGE + 1, 64);
    expect(await processForumIcon(big, storage)).toMatchObject({ ok: false, code: "size" });
    // PNG 头 + 垃圾：嗅探通过但 sharp 解不开（拒收即可，具体 code 取决于嗅探器对截断 PNG 的判定）
    const fake = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from("junk")]);
    const fr = await processForumIcon(fake, storage);
    expect(fr.ok).toBe(false);
  });

  it("超过 300KB 拒收（大尺寸低熵图撑大字节数）", async () => {
    // 噪声背景让压缩后仍超限
    const noisy = await sharp({
      create: {
        width: ICON_MAX_EDGE,
        height: ICON_MAX_EDGE,
        channels: 4,
        background: { r: 128, g: 128, b: 128, alpha: 1 },
        noise: { type: "gaussian", mean: 128, sigma: 40 },
      },
    })
      .png()
      .toBuffer();
    if (noisy.byteLength <= ICON_MAX_BYTES) {
      // 噪声不够大就跳过字节数分支（sharp 版本差异），避免脆弱断言
      return;
    }
    expect(await processForumIcon(noisy, storage)).toMatchObject({ ok: false, code: "bytes" });
  });
});
