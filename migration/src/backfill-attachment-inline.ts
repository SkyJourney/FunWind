import { newQuery } from "./db.js";

/**
 * 旧帖附件清洗（M10.6 收尾，站长 2026-10-28 同意）：
 * 迁移历史里"上传图片→插入正文"的帖，其附件行全是 kind='download'——
 * 帖末下载区因此与正文插图重复展示。按精确口径清洗：
 *   download 行 + 图片 mime + 本帖正文（body_md）含 /files/<storage_key> 完整引用
 *   → 改写 kind='inline'（gate_id 保留，供门控图片语义不动）。
 *
 * 幂等：WHERE 已限定 kind='download'，改完后不再命中。
 * 每帖一条审计（actor NULL=cli，action=attachment.kind_backfill）。
 *
 * 运行：pnpm --filter @funwind/migration exec tsx src/backfill-attachment-inline.ts
 */

const BATCH = 500;

async function main() {
  // 候选：download 图片行，其所在帖正文含完整 /files/<key> 引用
  const rows = (await newQuery(
    `SELECT a.id, a.post_id, f.storage_key
       FROM attachments a
       JOIN files f ON f.id = a.file_id
      WHERE a.kind = 'download'
        AND f.mime LIKE 'image%'
        AND EXISTS (
          SELECT 1 FROM posts p
           WHERE p.id = a.post_id AND p.body_md LIKE CONCAT('%/files/', f.storage_key, '%')
        )`,
  )) as { id: number; post_id: number; storage_key: string }[];

  console.log(`[attach-clean] 候选 ${rows.length} 行`);

  const postSet = new Set<number>();
  let converted = 0;
  for (const r of rows.slice(0, BATCH * 20)) {
    const res = (await newQuery(
      "UPDATE attachments SET kind = 'inline' WHERE id = ? AND kind = 'download'",
      [r.id],
    )) as unknown as { affectedRows: number };
    converted += res.affectedRows > 0 ? 1 : 0;
    postSet.add(r.post_id);
  }

  for (const postId of postSet) {
    await newQuery(
      "INSERT INTO audit_log (actor_id, action, target_type, target_id, before_json, after_json, created_at) " +
        "VALUES (NULL, 'attachment.kind_backfill', 'post', ?, NULL, ?, NOW())",
      [String(postId), JSON.stringify({ via: "cli", note: "download→inline 图片已在正文引用" })],
    );
  }

  const [{ remain }] = (await newQuery(
    `SELECT COUNT(*) AS remain FROM attachments a JOIN files f ON f.id = a.file_id
      WHERE a.kind = 'download' AND f.mime LIKE 'image%'
        AND EXISTS (SELECT 1 FROM posts p WHERE p.id = a.post_id AND p.body_md LIKE CONCAT('%/files/', f.storage_key, '%'))`,
  )) as { remain: number }[];

  console.log(
    `[attach-clean] 改写 ${converted} 行（${postSet.size} 帖）；清洗后仍命中 ${remain}（应为 0）`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("[attach-clean] 失败：", e);
  process.exit(1);
});
