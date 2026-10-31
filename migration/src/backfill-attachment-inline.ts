import { affectedRowsOf } from "@funwind/db";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closePools, newQuery, withNewTransaction } from "./db.js";

const POSTS_PER_BATCH = 100;
const CANDIDATE_POSTS_SQL = `
  SELECT DISTINCT a.post_id
    FROM attachments a
    JOIN files f ON f.id = a.file_id
    JOIN posts p ON p.id = a.post_id
   WHERE a.kind = 'download'
     AND f.mime LIKE 'image%'
     AND p.body_md LIKE CONCAT('%/files/', f.storage_key, '%')
     AND a.post_id > ?
   ORDER BY a.post_id
   LIMIT ?`;
const CONVERT_POST_SQL = `
  UPDATE attachments a
  JOIN files f ON f.id = a.file_id
  JOIN posts p ON p.id = a.post_id
     SET a.kind = 'inline'
   WHERE a.post_id = ?
     AND a.kind = 'download'
     AND f.mime LIKE 'image%'
     AND p.body_md LIKE CONCAT('%/files/', f.storage_key, '%')`;
const INSERT_AUDIT_SQL =
  "INSERT INTO audit_log (actor_id, action, target_type, target_id, before_json, after_json, created_at) " +
  "VALUES (NULL, 'attachment.kind_backfill', 'post', ?, NULL, ?, NOW())";

export interface AttachmentInlineBackfillResult {
  converted: number;
  auditedPosts: number;
  remaining: number;
}

export interface BackfillConnection {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export interface BackfillDatabase {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(run: (connection: BackfillConnection) => Promise<T>): Promise<T>;
}

/** 按帖子分页，每批内把该帖的全部附件改写与单条审计放在同一事务。 */
export async function backfillAttachmentInline(
  database: BackfillDatabase = { query: newQuery, transaction: withNewTransaction },
  postsPerBatch = POSTS_PER_BATCH,
): Promise<AttachmentInlineBackfillResult> {
  if (!Number.isInteger(postsPerBatch) || postsPerBatch <= 0) {
    throw new RangeError("postsPerBatch 必须是正整数");
  }

  let lastPostId = 0;
  let converted = 0;
  let auditedPosts = 0;
  while (true) {
    const candidates = await database.query<{ post_id: number }>(CANDIDATE_POSTS_SQL, [
      lastPostId,
      postsPerBatch,
    ]);
    if (candidates.length === 0) break;

    let batchConverted = 0;
    let batchAuditedPosts = 0;
    await database.transaction(async (connection) => {
      for (const { post_id: postId } of candidates) {
        const result = await connection.query(CONVERT_POST_SQL, [postId]);
        const affected = affectedRowsOf(result);
        if (affected === 0) continue;
        await connection.query(INSERT_AUDIT_SQL, [
          String(postId),
          JSON.stringify({ via: "cli", note: "download→inline 图片已在正文引用" }),
        ]);
        batchConverted += affected;
        batchAuditedPosts++;
      }
    });

    converted += batchConverted;
    auditedPosts += batchAuditedPosts;
    lastPostId = Number(candidates[candidates.length - 1]!.post_id);
  }

  const [row] = await database.query<{ remain: number }>(`
    SELECT COUNT(*) AS remain
      FROM attachments a
      JOIN files f ON f.id = a.file_id
     WHERE a.kind = 'download'
       AND f.mime LIKE 'image%'
       AND EXISTS (
         SELECT 1
           FROM posts p
          WHERE p.id = a.post_id
            AND p.body_md LIKE CONCAT('%/files/', f.storage_key, '%')
       )`);
  const remaining = Number(row?.remain ?? 0);
  if (remaining > 0) {
    throw new Error(`[attach-clean] 清洗后仍有 ${remaining} 行候选附件`);
  }
  return { converted, auditedPosts, remaining };
}

async function main(): Promise<void> {
  let failure: unknown;
  try {
    const result = await backfillAttachmentInline();
    console.log(
      `[attach-clean] 改写 ${result.converted} 行（${result.auditedPosts} 帖）；清洗后仍命中 ${result.remaining}（应为 0）`,
    );
  } catch (error) {
    failure = error;
  }
  try {
    await closePools();
  } catch (error) {
    failure ??= error;
  }
  if (failure) {
    console.error("[attach-clean] 失败：", failure);
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (entryPath === fileURLToPath(import.meta.url)) void main();
