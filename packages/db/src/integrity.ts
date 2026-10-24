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
