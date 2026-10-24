/**
 * 文件管线（迁移适配层）：把旧站磁盘上的文件登记进新存储的内容寻址布局。
 *
 *  - 存储键由内容哈希派生：`ab/cd/<sha256>.<ext>`，不含任何业务含义；同内容只存一份
 *  - FileCollector 在转换阶段收集「真正被引用」的文件（正文内联图、附件、头像、徽章图）并按需计算哈希，
 *    转换时即可得到最终地址 `/files/<storage_key>`（地址只取决于内容，不依赖 files.id）
 *  - 转换结束后由 files 步骤统一分配 id、复制文件、写 files 表
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  txt: "text/plain",
  zip: "application/zip",
  rar: "application/vnd.rar",
  "7z": "application/x-7z-compressed",
  torrent: "application/x-bittorrent",
};

/** 扩展名（小写，去点）；不合法的扩展名一律归为 bin，避免出现在存储路径里 */
export function safeExt(nameOrPath: string): string {
  const ext = extname(nameOrPath).slice(1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : "bin";
}

export const mimeOfExt = (ext: string): string => MIME_BY_EXT[ext] ?? "application/octet-stream";

/** 存储键：前两级目录各取哈希的两位十六进制，打散目录 */
export function storageKeyOf(sha256: string, ext: string): string {
  return `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}.${ext}`;
}

export const fileUrl = (storageKey: string): string => `/files/${storageKey}`;

/**
 * 把「根目录 + 相对路径」收束在根目录之内。相对路径来自旧站数据（帖子正文、附件表），属于不可信输入：
 * 含 `..`、绝对路径、NUL 字节，或经符号链接逃出根目录的一律拒绝（返回 null），
 * 否则迁移会读取本机任意文件并把它复制进公开的 /files/。
 */
export function confinedPath(root: string, rel: string): string | null {
  if (rel === "" || rel.includes("\0") || isAbsolute(rel)) return null;
  if (rel.split(/[\\/]/).includes("..")) return null;
  const base = resolve(root);
  const p = resolve(base, rel);
  if (!p.startsWith(base + sep)) return null;
  if (!existsSync(p)) return p; // 不存在的路径交给 add() 记为缺失
  const realBase = realpathSync(base);
  const real = realpathSync(p);
  return real.startsWith(realBase + sep) ? real : null;
}

export interface CollectedFile {
  sha256: string;
  storageKey: string;
  ext: string;
  mime: string;
  sizeBytes: number;
  /** 首次登记时的磁盘绝对路径（复制来源） */
  sourcePath: string;
}

/**
 * 文件收集器：按绝对路径登记文件，内容相同的合并为一条。
 * 同内容出现多种扩展名时，以首次登记者为准（处理顺序是确定的，结果因此确定）。
 */
export class FileCollector {
  private readonly byPath = new Map<string, CollectedFile | null>();
  private readonly bySha = new Map<string, CollectedFile>();
  /** 登记次数（含重复引用），用于报告去重收益 */
  referenceCount = 0;
  /** 磁盘上找不到的路径 */
  readonly missing = new Set<string>();
  /** 因逃出根目录而被拒绝的相对路径（报告里列出，供站长复核数据） */
  readonly rejected = new Set<string>();

  /** 登记根目录之下的相对路径；路径逃出根目录返回 null（记入 rejected），文件不存在返回 null（记入 missing） */
  addUnder(root: string, rel: string): CollectedFile | null {
    const p = confinedPath(root, rel);
    if (!p) {
      this.referenceCount++;
      this.rejected.add(rel);
      return null;
    }
    return this.add(p);
  }

  /** 登记一个文件；文件不存在返回 null（并记入 missing） */
  add(absPath: string): CollectedFile | null {
    this.referenceCount++;
    const memo = this.byPath.get(absPath);
    if (memo !== undefined) return memo;
    if (!existsSync(absPath) || !statSync(absPath).isFile()) {
      this.byPath.set(absPath, null);
      this.missing.add(absPath);
      return null;
    }
    const buf = readFileSync(absPath);
    const sha256 = createHash("sha256").update(buf).digest("hex");
    let entry = this.bySha.get(sha256);
    if (!entry) {
      const ext = safeExt(absPath);
      entry = {
        sha256,
        storageKey: storageKeyOf(sha256, ext),
        ext,
        mime: mimeOfExt(ext),
        sizeBytes: buf.length,
        sourcePath: absPath,
      };
      this.bySha.set(sha256, entry);
    }
    this.byPath.set(absPath, entry);
    return entry;
  }

  /** 去重后的全部文件，按 sha256 升序（files.id 据此分配，保证重跑一致） */
  all(): CollectedFile[] {
    return [...this.bySha.values()].sort((a, b) => (a.sha256 < b.sha256 ? -1 : 1));
  }

  get size(): number {
    return this.bySha.size;
  }
}

/**
 * 把文件复制到存储根目录；目标已存在且大小一致则跳过（内容寻址：同名即同内容）。
 * 返回 { copied, existing }。
 */
export function materialize(
  files: readonly CollectedFile[],
  storageDir: string,
): { copied: number; existing: number } {
  let copied = 0;
  let existing = 0;
  for (const f of files) {
    const dest = join(storageDir, f.storageKey);
    if (existsSync(dest) && statSync(dest).size === f.sizeBytes) {
      existing++;
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(f.sourcePath, dest);
    copied++;
  }
  return { copied, existing };
}

/** 重新计算存储中文件的哈希，返回与登记值不一致（或缺失）的存储键——对账用 */
export function auditStored(
  files: readonly { sha256: string; storageKey: string }[],
  storageDir: string,
): string[] {
  const bad: string[] = [];
  for (const f of files) {
    const p = join(storageDir, f.storageKey);
    if (!existsSync(p)) {
      bad.push(f.storageKey);
      continue;
    }
    const sha = createHash("sha256").update(readFileSync(p)).digest("hex");
    if (sha !== f.sha256) bad.push(f.storageKey);
  }
  return bad;
}
