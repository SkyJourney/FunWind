import "server-only";

import { eq, sql } from "drizzle-orm";
import { files } from "@funwind/db";
import type { DbTx } from "@/lib/audit";

export interface FileRecordInput {
  sha256: string;
  storageKey: string;
  sizeBytes: number;
  mime: string;
  width: number | null;
  height: number | null;
}

/**
 * 在调用方事务内按内容哈希登记文件；命中已有内容时保留全部元字段。
 * 只使用传入的事务句柄，不另借连接，也不写上传归属记录或消耗用户配额。
 */
export async function upsertFileRecordInTx(
  tx: DbTx,
  input: FileRecordInput,
): Promise<{ fileId: number }> {
  await tx
    .insert(files)
    .ignore()
    .values({
      sha256: input.sha256,
      storageKey: input.storageKey,
      sizeBytes: input.sizeBytes,
      mime: input.mime,
      width: input.width,
      height: input.height,
      createdAt: sql`NOW()`,
    });
  const [row] = await tx
    .select({ id: files.id })
    .from(files)
    .where(eq(files.sha256, input.sha256))
    .limit(1);
  if (!row) throw new Error("files 插入后查不到行（不应发生）");
  return { fileId: row.id };
}
