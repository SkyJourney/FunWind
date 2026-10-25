/**
 * 正文中的文件引用抽取（M6.4，docs/milestones/M6.4-uploads.md §6）。
 *
 * 保存帖子时，服务端要知道正文（含门控隐藏正文）引用了哪些 `/files/<key>`，以登记 attachments.kind='inline' 行。
 * 这里只做纯文本抽取：门控正文由 splitSource 切出后经由返回值交给调用方，不在 web 侧直接读取 hiddenMd
 * （硬约定 3b：hiddenMd 只能在门控服务内引用，本包不受 web 守卫扫描）。
 */
import { splitSource } from "./gate-syntax.js";

/** 与 apps/web 的 /files 路由同一形态：ab/cd/<64 位小写十六进制>.<ext>，且前两级目录等于哈希前缀 */
const FILE_REF_RE =
  /\/files\/([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{64}\.[a-z0-9]{1,8})(?![A-Za-z0-9])/g;

export interface FileRefs {
  /** 公开部分引用的 storage_key（保序、去重） */
  publicRefs: string[];
  /** 每个门控隐藏正文引用的 storage_key（只含有引用的门控，保序、去重） */
  gateRefs: { key: string; refs: string[] }[];
}

/** 从文本里抽取合法的 storage_key（保序、去重；目录与哈希前缀不一致的一律忽略） */
export function extractKeys(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(FILE_REF_RE)) {
    const [, d1, d2, rest] = m;
    const key = `${d1}/${d2}/${rest}`;
    if (!rest!.startsWith(`${d1}${d2}`)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * 从完整源码（含 `:::gate` 块）抽取文件引用。
 * 有语法错误时仍尽力返回；调用方在保存时以 splitSource 的 errors 为准拒绝保存，这里不替它判断。
 */
export function extractFileRefs(source: string): FileRefs {
  const { publicMd, gates } = splitSource(source);
  const publicRefs = extractKeys(publicMd);
  const gateRefs = gates
    .map((g) => ({ key: g.key, refs: extractKeys(g.hiddenMd) }))
    .filter((g) => g.refs.length > 0);
  return { publicRefs, gateRefs };
}
