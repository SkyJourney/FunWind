/**
 * 上传的落盘与登记（M6.4b，设计稿 §3、§8）。`files` / `file_uploads` 的唯一写入口（守卫 uploads-guard.test.ts）。
 *
 * 顺序（见计划「对设计稿的修正」第 5 条）：
 *  1. 非权威配额预检（事务外，防止超额用户反复上传填满磁盘）；
 *  2. 内容寻址落盘：写 STORAGE_DIR/.tmp/<随机> 再 rename 到 ab/cd/<sha>.<ext>，已存在则跳过；
 *  3. 事务（READ COMMITTED，死锁重试）：lockUserStats 串行化同一用户 → 权威配额检查（含去重命中，计数口径一致）
 *     → INSERT IGNORE files（按 sha256 去重）→ INSERT file_uploads → 头像时更新 user_profiles.avatar_file_id。
 * 事务失败只留下可被 gc 巡检报告的孤儿文件，不会出现「有行没文件」。
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, count, eq, gte, sql } from "drizzle-orm";
import { files, fileUploads, getWebDb, userProfiles } from "@funwind/db";
import type { DbExecutor } from "@/lib/audit";
import { lockUserStats } from "@/lib/posting/locks";
import { dailyQuotaExceeded } from "@/lib/posting/policy";
import { withDeadlockRetry, POINTS_TX_OPTIONS } from "@/lib/points/retry";
import { MIME_OF, type SniffedType } from "./types";
import { storageKeyFor } from "./policy";

export interface StoreInput {
  userId: number;
  /** 已处理（重编码 / 定向 / 去元数据后）的最终字节 */
  bytes: Buffer;
  sniffed: SniffedType;
  width: number | null;
  height: number | null;
  /** 头像：同事务写入 user_profiles.avatar_file_id */
  avatar: boolean;
}

export interface StoredFile {
  fileId: number;
  sha256: string;
  storageKey: string;
  mime: string;
  width: number | null;
  height: number | null;
  sizeBytes: number;
}

export type StoreResult = { ok: true; file: StoredFile } | { ok: false; code: "quota_exceeded" };

/** 注销时清除个人上传配额/归属记录；内容引用的文件与附件不在此删除。 */
export async function deleteUserUploadHistoryInTx(tx: DbExecutor, userId: number): Promise<void> {
  await tx.delete(fileUploads).where(eq(fileUploads.userId, userId));
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 今日已上传次数（北京日，会话时区 +08:00 下 CURDATE 即北京日） */
async function uploadsToday(userId: number, executor: DbExecutor): Promise<number> {
  const [row] = await executor
    .select({ n: count() })
    .from(fileUploads)
    .where(and(eq(fileUploads.userId, userId), gte(fileUploads.createdAt, sql`CURDATE()`)));
  return Number(row?.n ?? 0);
}

/** 非权威预检：尽早拒绝明显超额的请求，不持锁、不保证并发下精确 */
export async function quotaPrecheck(userId: number, uploadsPerDay: number): Promise<boolean> {
  if (uploadsPerDay <= 0) return true;
  return !dailyQuotaExceeded(await uploadsToday(userId, getWebDb()), uploadsPerDay);
}

/** 落盘：已存在则不写；否则写临时文件再原子 rename（内容寻址的唯一实现，表情上传同用） */
export async function writeContentAddressed(
  storageDir: string,
  key: string,
  bytes: Buffer,
): Promise<void> {
  const finalPath = path.join(storageDir, key);
  try {
    await stat(finalPath);
    return;
  } catch {
    // 不存在：继续写入
  }
  await mkdir(path.dirname(finalPath), { recursive: true });
  const tmpDir = path.join(storageDir, ".tmp");
  await mkdir(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, randomBytes(12).toString("hex"));
  await writeFile(tmpPath, bytes);
  await rename(tmpPath, finalPath);
}

export async function storeUpload(
  input: StoreInput,
  opts: { storageDir: string; uploadsPerDay: number },
): Promise<StoreResult> {
  const sha256 = sha256Hex(input.bytes);
  const storageKey = storageKeyFor(sha256, input.sniffed);
  const mime = MIME_OF[input.sniffed];

  if (!(await quotaPrecheck(input.userId, opts.uploadsPerDay))) {
    return { ok: false, code: "quota_exceeded" };
  }

  await writeContentAddressed(opts.storageDir, storageKey, input.bytes);

  const fileId = await withDeadlockRetry(() =>
    getWebDb().transaction(async (tx) => {
      // 同一用户的上传在此串行：配额计数与登记不会被并发绕过
      await lockUserStats(tx, input.userId);
      if (
        opts.uploadsPerDay > 0 &&
        dailyQuotaExceeded(await uploadsToday(input.userId, tx), opts.uploadsPerDay)
      ) {
        return null;
      }

      // 按内容哈希去重：已存在则复用行，不改已有字段
      await tx
        .insert(files)
        .ignore()
        .values({
          sha256,
          storageKey,
          sizeBytes: input.bytes.byteLength,
          mime,
          width: input.width,
          height: input.height,
          createdAt: sql`NOW()`,
        });
      const [row] = await tx.select({ id: files.id }).from(files).where(eq(files.sha256, sha256));
      if (!row) throw new Error("files 插入后查不到行（不应发生）");

      // 每次成功上传都记一行（含去重命中），配额口径不随去重改变
      await tx.insert(fileUploads).values({
        userId: input.userId,
        fileId: row.id,
        sizeBytes: input.bytes.byteLength,
        createdAt: sql`NOW()`,
      });

      if (input.avatar) {
        await tx
          .insert(userProfiles)
          .values({ userId: input.userId, avatarFileId: row.id })
          .onDuplicateKeyUpdate({ set: { avatarFileId: row.id } });
      }
      return row.id;
    }, POINTS_TX_OPTIONS),
  );

  if (fileId === null) return { ok: false, code: "quota_exceeded" };
  return {
    ok: true,
    file: {
      fileId,
      sha256,
      storageKey,
      mime,
      width: input.width,
      height: input.height,
      sizeBytes: input.bytes.byteLength,
    },
  };
}
