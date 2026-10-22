import { oldQuery, upsertBatch, j } from '../db.js';
import { toDatetime, config } from '../config.js';
import { ubbToMarkdown } from '../ubb.js';
import type { EmoCtx, Migrator } from '../run.js';

/** 广告空壳主题判定：无首帖正文 且 无任何回帖（3,033 条，2018-11 洪泛为主） */
export async function loadSpamThreads(): Promise<Set<number>> {
  const rows = await oldQuery(`
    SELECT t.tid FROM nw_bbs_threads t
    LEFT JOIN nw_bbs_threads_content c ON c.tid = t.tid
    WHERE c.tid IS NULL
      AND NOT EXISTS (SELECT 1 FROM nw_bbs_posts p WHERE p.tid = t.tid)`);
  return new Set(rows.map((r) => Number(r.tid)));
}

export function makeThreads(emo: EmoCtx): Migrator {
  return {
    name: 'threads',
    async run() {
      const spamThreads = await loadSpamThreads();
      const maxRow = (await oldQuery(`SELECT MAX(tid) m FROM nw_bbs_threads`))[0];
      const max = Number(maxRow?.m ?? 0);
      const cols = ['id', 'forum_id', 'author_id', 'title', 'type_id', 'digest', 'topped', 'special',
        'reply_count', 'view_count', 'like_count', 'attach_count', 'content_md', 'content_raw',
        'usehtml', 'tags', 'is_spam', 'status', 'created_at', 'last_post_at',
        'last_post_user_id', 'raw'];
      let total = 0;
      for (let lo = 0; lo <= max; lo += config.batchSize) {
        const hi = lo + config.batchSize - 1;
        const rows = await oldQuery(
          `SELECT t.tid, t.fid, t.topic_type, t.subject, t.digest, t.topped, t.special,
                  t.ifshield, t.disabled, t.replies, t.hits, t.like_count, t.created_time,
                  t.created_userid, t.lastpost_time, t.lastpost_userid,
                  c.content, c.usehtml, c.aids, c.tags
           FROM nw_bbs_threads t
           LEFT JOIN nw_bbs_threads_content c ON c.tid = t.tid
           WHERE t.tid BETWEEN ? AND ?`, [lo, hi]);
        if (rows.length === 0) continue;
        await upsertBatch('threads', cols, rows.map((r) => {
          const tid = Number(r.tid);
          const status = Number(r.disabled) > 0 ? 1 : Number(r.ifshield) > 0 ? 2 : 0;
          return {
            id: tid,
            forum_id: r.fid ?? 0,
            author_id: r.created_userid ?? 0,
            title: r.subject ?? '',
            type_id: r.topic_type ?? 0,
            digest: r.digest ?? 0,
            topped: r.topped ?? 0,
            special: String(r.special ?? ''),
            reply_count: r.replies ?? 0,
            view_count: r.hits ?? 0,
            like_count: r.like_count ?? 0,
            attach_count: r.aids ?? 0,
            content_md: ubbToMarkdown(r.content, emo) || null,
            content_raw: r.content ?? null,
            usehtml: Number(r.usehtml ?? 0) > 0 ? 1 : 0,
            tags: r.tags ?? '',
            is_spam: spamThreads.has(tid) ? 1 : 0,
            status,
            created_at: toDatetime(r.created_time),
            last_post_at: toDatetime(r.lastpost_time),
            last_post_user_id: r.lastpost_userid ?? 0,
            raw: j(r),
          };
        }), ['id']);
        total += rows.length;
      }
      return { rows: total, note: `其中 ${spamThreads.size} 条标记 is_spam（广告空壳）` };
    },
  };
}

export function makePosts(emo: EmoCtx): Migrator {
  return {
    name: 'posts',
    async run() {
      const maxRow = (await oldQuery(`SELECT MAX(pid) m FROM nw_bbs_posts`))[0];
      const max = Number(maxRow?.m ?? 0);
      const cols = ['id', 'thread_id', 'author_id', 'floor', 'reply_to_pid', 'subject',
        'content_md', 'content_raw', 'usehtml', 'like_count', 'status', 'created_at',
        'modified_at', 'raw'];
      const floorOf = new Map<number, number>(); // tid → 下一楼层号
      let total = 0;
      for (let lo = 0; lo <= max; lo += config.batchSize) {
        const hi = lo + config.batchSize - 1;
        // 按 tid,created_time,pid 排序保证楼层号稳定（跨批次用 floorOf 续接）
        const rows = await oldQuery(
          `SELECT p.pid, p.tid, p.created_userid, p.rpid, p.subject, p.content, p.usehtml,
                  p.like_count, p.disabled, p.ifshield, p.created_time, p.modified_time
           FROM nw_bbs_posts p
           WHERE p.pid BETWEEN ? AND ?
           ORDER BY p.tid, p.created_time, p.pid`, [lo, hi]);
        if (rows.length === 0) continue;
        await upsertBatch('posts', cols, rows.map((r) => {
          const tid = Number(r.tid);
          const floor = (floorOf.get(tid) ?? 0) + 1;
          floorOf.set(tid, floor);
          const status = Number(r.disabled) > 0 ? 1 : Number(r.ifshield) > 0 ? 2 : 0;
          return {
            id: r.pid,
            thread_id: tid,
            author_id: r.created_userid ?? 0,
            floor,
            reply_to_pid: Number(r.rpid) > 0 ? r.rpid : null,
            subject: r.subject ?? '',
            content_md: ubbToMarkdown(r.content, emo) || null,
            content_raw: r.content ?? null,
            usehtml: Number(r.usehtml ?? 0) > 0 ? 1 : 0,
            like_count: r.like_count ?? 0,
            status,
            created_at: toDatetime(r.created_time),
            modified_at: toDatetime(r.modified_time),
            raw: j(r),
          };
        }), ['id']);
        total += rows.length;
      }
      return { rows: total };
    },
  };
}
