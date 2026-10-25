/**
 * 孤儿文件巡检（M6.4，设计稿 §8）：只读查询，列出「没有任何引用」且超过宽限期的 files 行。
 * 引用包括：附件（下载附件与内联行）、用户头像、徽章图标、公开正文中的 /files 链接。上传记录（file_uploads）不算引用：
 * 上传后未保存的文件正是要被发现的孤儿。
 * 宽限期 24 小时：刚上传、尚未保存的文件不算孤儿。M6 只报告，不删除任何文件。
 */
import type { Pool, RowDataPacket } from "mysql2/promise";

export interface OrphanFile {
  id: number;
  storageKey: string;
  sizeBytes: number;
  createdAt: string;
}

export const ORPHAN_GRACE_HOURS = 24;

export async function findOrphanFiles(pool: Pool): Promise<OrphanFile[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT f.id, f.storage_key AS storageKey, f.size_bytes AS sizeBytes, f.created_at AS createdAt
       FROM files f
      WHERE f.created_at < NOW() - INTERVAL ${ORPHAN_GRACE_HOURS} HOUR
        -- 去重命中不更新 files.created_at：宽限期须同时看最近一次上传记录，否则别人刚上传的旧文件会被误报
        AND NOT EXISTS (
          SELECT 1 FROM file_uploads u
           WHERE u.file_id = f.id AND u.created_at >= NOW() - INTERVAL ${ORPHAN_GRACE_HOURS} HOUR
        )
        AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.file_id = f.id)
        AND NOT EXISTS (SELECT 1 FROM user_profiles p WHERE p.avatar_file_id = f.id)
        AND NOT EXISTS (SELECT 1 FROM badges b WHERE b.icon_file_id = f.id)
        -- 正文里的引用：迁移导入的内联图没有附件行，只在 body_md 中出现（只读公开正文，不读隐藏正文）
        AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.body_md LIKE CONCAT('%/files/', f.storage_key, '%'))
      ORDER BY f.id`,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    storageKey: String(r.storageKey),
    sizeBytes: Number(r.sizeBytes),
    createdAt: String(r.createdAt),
  }));
}
