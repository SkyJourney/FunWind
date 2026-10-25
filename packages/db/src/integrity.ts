/**
 * 数据完整性检查（库内无外键，约束靠检查与测试守住）。同时被 db:verify 与集成测试使用。
 */
import type { Pool, RowDataPacket } from "mysql2/promise";

/** 附件 ↔ 门控的异常计数（docs/ATTACHMENT-GATES.md §4.1），任一项非零都是数据错误 */
export interface AttachmentGateAnomalies {
  /** gate_id 非空，但没有这条门控 */
  dangling: number;
  /** 门控存在，但属于另一个帖子 */
  crossPost: number;
  /** gate_id 非空，但所属帖子 has_gate=0（门控标记与附件归属不一致） */
  onUngatedPost: number;
}

export async function findAttachmentGateAnomalies(pool: Pool): Promise<AttachmentGateAnomalies> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT
       COALESCE(SUM(g.id IS NULL), 0) AS dangling,
       COALESCE(SUM(g.id IS NOT NULL AND g.post_id <> a.post_id), 0) AS crossPost,
       COALESCE(SUM(p.has_gate = 0), 0) AS onUngatedPost
     FROM attachments a
     LEFT JOIN post_gates g ON g.id = a.gate_id
     LEFT JOIN posts p ON p.id = a.post_id
     WHERE a.gate_id IS NOT NULL`,
  );
  const r = rows[0] ?? {};
  return {
    dangling: Number(r.dangling ?? 0),
    crossPost: Number(r.crossPost ?? 0),
    onUngatedPost: Number(r.onUngatedPost ?? 0),
  };
}

/**
 * 结构完整性的异常计数。任一项非零都是数据错误（库内无外键，由本检查与写路径共同守住）。
 */
export interface StructuralAnomalies {
  /** posts.thread_id 指向不存在的主题 */
  orphanPosts: number;
  /** threads.forum_id 指向不存在的版块 */
  orphanThreads: number;
  /** post_gates.post_id 指向不存在的帖子 */
  orphanPostGates: number;
  /** attachments.post_id 指向不存在的帖子 */
  orphanAttachments: number;
  /** uq_posts_thread_floor 是否存在且为 (thread_id, floor) 的唯一索引 */
  floorIndexOk: boolean;
  /** (thread_id, floor) 重复的组数（唯一索引存在时应恒为 0；索引缺失时是兜底检查） */
  floorDuplicates: number;
  /** first_post_id 为空，或不指向本主题楼层 1 的帖子 */
  firstPostMissing: number;
  /** 主题状态与首帖状态不一致（写路径的状态迁移保证二者同步） */
  stateMismatch: number;
}

/**
 * 结构完整性检查。只读，可在任何库上运行（空库全部为零）。
 * 同时被 db:verify 与集成测试使用。
 */
export async function findStructuralAnomalies(pool: Pool): Promise<StructuralAnomalies> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT
       (SELECT COUNT(*) FROM posts p LEFT JOIN threads t ON t.id = p.thread_id WHERE t.id IS NULL) AS orphanPosts,
       (SELECT COUNT(*) FROM threads t LEFT JOIN forums f ON f.id = t.forum_id WHERE f.id IS NULL) AS orphanThreads,
       (SELECT COUNT(*) FROM post_gates g LEFT JOIN posts p ON p.id = g.post_id WHERE p.id IS NULL) AS orphanPostGates,
       (SELECT COUNT(*) FROM attachments a LEFT JOIN posts p ON p.id = a.post_id WHERE p.id IS NULL) AS orphanAttachments,
       (SELECT COUNT(*) FROM (
          SELECT thread_id, floor FROM posts GROUP BY thread_id, floor HAVING COUNT(*) > 1
        ) d) AS floorDuplicates,
       (SELECT COUNT(*) FROM threads t
          LEFT JOIN posts p ON p.id = t.first_post_id AND p.thread_id = t.id AND p.floor = 1
         WHERE p.id IS NULL) AS firstPostMissing,
       (SELECT COUNT(*) FROM threads t JOIN posts p ON p.id = t.first_post_id AND p.thread_id = t.id
         WHERE p.state <> t.state) AS stateMismatch`,
  );
  // 唯一索引：列集合必须恰好是 (thread_id, floor)，顺序也要一致
  const [idx] = await pool.query<RowDataPacket[]>(
    `SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'posts'
        AND INDEX_NAME = 'uq_posts_thread_floor' AND NON_UNIQUE = 0
      GROUP BY INDEX_NAME`,
  );
  const r = rows[0] ?? {};
  return {
    orphanPosts: Number(r.orphanPosts ?? 0),
    orphanThreads: Number(r.orphanThreads ?? 0),
    orphanPostGates: Number(r.orphanPostGates ?? 0),
    orphanAttachments: Number(r.orphanAttachments ?? 0),
    floorIndexOk: idx[0]?.cols === "thread_id,floor",
    floorDuplicates: Number(r.floorDuplicates ?? 0),
    firstPostMissing: Number(r.firstPostMissing ?? 0),
    stateMismatch: Number(r.stateMismatch ?? 0),
  };
}

/**
 * 内联图片与上传记录的异常计数（M6.4，docs/milestones/M6.4-uploads.md §4、§6）。任一项非零都是数据错误。
 * 只统计 kind='inline' 的附件行；download 行由 findAttachmentGateAnomalies 守住。
 */
export interface InlineAttachmentAnomalies {
  /** inline 行的 gate_id 非空，但门控不存在或不属于同一帖子 */
  gateMismatch: number;
  /** inline 行引用的文件不存在 */
  missingFile: number;
  /** file_uploads 行引用的文件不存在 */
  uploadOrphan: number;
}

export async function findInlineAttachmentAnomalies(
  pool: Pool,
): Promise<InlineAttachmentAnomalies> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT
       (SELECT COUNT(*) FROM attachments a
          LEFT JOIN post_gates g ON g.id = a.gate_id
        WHERE a.kind = 'inline' AND a.gate_id IS NOT NULL
          AND (g.id IS NULL OR g.post_id <> a.post_id)) AS gateMismatch,
       (SELECT COUNT(*) FROM attachments a
          LEFT JOIN files f ON f.id = a.file_id
        WHERE a.kind = 'inline' AND f.id IS NULL) AS missingFile,
       (SELECT COUNT(*) FROM file_uploads u
          LEFT JOIN files f ON f.id = u.file_id
        WHERE f.id IS NULL) AS uploadOrphan`,
  );
  const r = rows[0] ?? {};
  return {
    gateMismatch: Number(r.gateMismatch ?? 0),
    missingFile: Number(r.missingFile ?? 0),
    uploadOrphan: Number(r.uploadOrphan ?? 0),
  };
}
