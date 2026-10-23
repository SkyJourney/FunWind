import path from "node:path";

/**
 * 静态资源文件解析（基线审查级安全要求，M3）：
 * - 逐段拒绝路径分隔符 / 点段 / 空段 / NUL（防 ../、%2e%2e、绝对路径注入）
 * - resolve 后强制前缀校验（双保险）
 * - Content-Type 按扩展名映射；非图片类强制 attachment 下载
 */

const SEGMENT_FORBIDDEN = /[/\\]|\.\.|^\.+$|\0/;

/** 解析 baseDir 下的安全绝对路径；非法段或越界返回 null */
export function resolveStaticPath(baseDir: string, segments: readonly string[]): string | null {
  if (segments.length === 0) return null;
  for (const seg of segments) {
    if (typeof seg !== "string" || seg.length === 0 || SEGMENT_FORBIDDEN.test(seg)) return null;
  }
  const baseResolved = path.resolve(baseDir);
  const full = path.resolve(baseResolved, ...segments);
  if (full !== baseResolved && !full.startsWith(baseResolved + path.sep)) return null;
  return full;
}

const EXT_TYPES: Record<string, { type: string; inline: boolean }> = {
  jpg: { type: "image/jpeg", inline: true },
  jpeg: { type: "image/jpeg", inline: true },
  png: { type: "image/png", inline: true },
  gif: { type: "image/gif", inline: true },
  webp: { type: "image/webp", inline: true },
  bmp: { type: "image/bmp", inline: true },
  svg: { type: "image/svg+xml", inline: true },
  txt: { type: "text/plain; charset=utf-8", inline: true },
  pdf: { type: "application/pdf", inline: true },
  mp3: { type: "audio/mpeg", inline: true },
  mp4: { type: "video/mp4", inline: true },
  torrent: { type: "application/x-bittorrent", inline: false },
  zip: { type: "application/zip", inline: false },
  "7z": { type: "application/x-7z-compressed", inline: false },
  rar: { type: "application/vnd.rar", inline: false },
};

/** 扩展名 → 响应头语义；未知扩展按二进制附件下载 */
export function contentDispositionFor(filename: string): { type: string; inline: boolean } {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TYPES[ext] ?? { type: "application/octet-stream", inline: false };
}
