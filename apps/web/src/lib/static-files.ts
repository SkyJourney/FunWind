import path from "node:path";

/**
 * 静态路径解析的穿越守卫（基线审查级安全要求，M3）。/files 路由用它收束存储路径。
 * Content-Type / 展示方式不再按扩展名推断（旧映射把 svg 标成 inline，是存储型 XSS 隐患），一律取自 files.mime，见 file-serving.ts。
 *
 * - 逐段拒绝路径分隔符 / 点段 / 空段 / NUL（防 ../、%2e%2e、绝对路径注入）
 * - resolve 后强制前缀校验（双保险）
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
