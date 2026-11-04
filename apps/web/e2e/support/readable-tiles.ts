import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { BANNER_H, TILE_MAX, tileSpans } from "./tile-spans";

/**
 * 可读切块导出（目视验收专用，详见 docs/VISUAL-VERIFICATION.md）。
 * 为什么必须切块、各尺寸的盲测结果与切块几何见 tile-spans.ts。
 * 每块都带标签条，同一轮读多张时按标签对位，不能按附件顺序对位——
 * 实测并行读取时附件到达顺序与调用顺序不一致。
 */

/** SVG 文本转义；标签来自用例作者，但仍按不可信输入处理 */
function escapeXml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!,
  );
}

/** 标签条：第一行是场景标签，第二行是原图尺寸与本块坐标；窄块按宽度截断文字 */
function bannerSvg(width: number, line1: string, line2: string): Buffer {
  const maxChars = Math.max(8, Math.floor(width / 6.4));
  const fit = (s: string) => (s.length > maxChars ? `${s.slice(0, maxChars - 1)}…` : s);
  const font = 'font-family="Helvetica, Arial, sans-serif" font-size="11"';
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${BANNER_H}">` +
      `<rect width="100%" height="100%" fill="#fff3a3"/>` +
      `<text x="4" y="12" ${font} font-weight="700" fill="#000">${escapeXml(fit(line1))}</text>` +
      `<text x="4" y="25" ${font} fill="#000">${escapeXml(fit(line2))}</text>` +
      `</svg>`,
  );
}

/**
 * 把一张截图（PNG 缓冲）切成带标签的可读块，返回写出的文件路径（行优先）。
 * 图本身不超过一块时也会导出一块，保证「验收只读 tiles 目录」这条规则没有例外。
 */
export async function exportReadableTiles(
  image: Buffer,
  options: { label: string; dir: string; baseName: string },
): Promise<string[]> {
  const meta = await sharp(image).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width === 0 || height === 0) throw new Error(`无法读取截图尺寸：${options.baseName}`);
  const columns = tileSpans(width, TILE_MAX);
  const rows = tileSpans(height, TILE_MAX - BANNER_H);
  await mkdir(options.dir, { recursive: true });
  const files: string[] = [];
  for (const [r, row] of rows.entries()) {
    for (const [c, col] of columns.entries()) {
      const coordinates =
        `${width}x${height} r${r + 1}/${rows.length} c${c + 1}/${columns.length} ` +
        `x${col.start}-${col.start + col.size} y${row.start}-${row.start + row.size}`;
      const tile = await sharp(image)
        .extract({ left: col.start, top: row.start, width: col.size, height: row.size })
        .extend({ top: BANNER_H, background: "#ffffff" })
        .composite([{ input: bannerSvg(col.size, options.label, coordinates), top: 0, left: 0 }])
        .png()
        .toBuffer();
      const file = path.join(options.dir, `${options.baseName}.r${r + 1}c${c + 1}.png`);
      await writeFile(file, tile);
      files.push(file);
    }
  }
  return files;
}
