#!/usr/bin/env node
/**
 * favicon 一次性生成（M13 Step 4，F9）：从站长定稿图 public/logo/qy2010.png 产出
 *   src/app/icon.png     —— Next 约定路由（浏览器/移动端 icon，定稿图原样）
 *   src/app/favicon.ico  —— 多尺寸（16/32/48）经典 favicon，PNG-in-ICO 容器
 * 产物随 git 发布，运行时不依赖 sharp；源图更换后重跑本脚本再提交。
 * 用法：pnpm exec tsx scripts/generate-favicon.mts（cwd=apps/web）
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const SOURCE = path.join(process.cwd(), "public", "logo", "qy2010.png");
const APP_DIR = path.join(process.cwd(), "src", "app");
const SIZES = [16, 32, 48] as const;

const source = await readFile(SOURCE);
const pngs = await Promise.all(
  SIZES.map((size) =>
    sharp(source)
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer(),
  ),
);

// ICO 容器：ICONDIR(6B) + N×ICONDIRENTRY(16B) + 各尺寸 PNG 数据（PNG-in-ICO，Vista+ 全支持）
const imageOffset = 6 + SIZES.length * 16;
const dir = Buffer.alloc(imageOffset);
dir.writeUInt16LE(0, 0); // reserved
dir.writeUInt16LE(1, 2); // type: icon
dir.writeUInt16LE(SIZES.length, 4); // count

let cursor = imageOffset;
for (let i = 0; i < SIZES.length; i++) {
  const entryAt = 6 + i * 16;
  const size = SIZES[i]!;
  dir.writeUInt8(size === 256 ? 0 : size, entryAt); // width（256 记 0；本集 ≤48）
  dir.writeUInt8(size === 256 ? 0 : size, entryAt + 1); // height
  dir.writeUInt8(0, entryAt + 2); // palette
  dir.writeUInt8(0, entryAt + 3); // reserved
  dir.writeUInt16LE(1, entryAt + 4); // planes
  dir.writeUInt16LE(32, entryAt + 6); // bpp
  dir.writeUInt32LE(pngs[i]!.length, entryAt + 8); // data size
  dir.writeUInt32LE(cursor, entryAt + 12); // data offset
  cursor += pngs[i]!.length;
}

await mkdir(APP_DIR, { recursive: true });
await writeFile(path.join(APP_DIR, "icon.png"), source); // 定稿图原样（224²，浏览器端缩放）
await writeFile(
  path.join(APP_DIR, "favicon.ico"),
  Buffer.concat([dir, ...pngs.map((p) => Buffer.from(p))]),
);
console.log(
  `✔ favicon 已生成：src/app/icon.png（源图原样）+ src/app/favicon.ico（${SIZES.join("/")}）`,
);
