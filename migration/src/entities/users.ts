import { oldQuery, upsertBatch, j } from '../db.js';
import { toDatetime, config } from '../config.js';
import { ubbToMarkdown } from '../ubb.js';
import type { EmoCtx } from '../run.js';
import type { Migrator } from '../run.js';

function packCredits(r: Record<string, unknown>): string {
  const out: Record<string, number> = {};
  for (let n = 1; n <= 8; n++) out[String(n)] = Number(r[`credit${n}`] ?? 0);
  return JSON.stringify(out);
}

/** 广告注册/发帖用户判定（保守规则：只发过空壳广告帖、且全站无任何正常内容） */
export async function loadSpamUsers(): Promise<Set<number>> {
  const shellOnly = await oldQuery(`
    SELECT t.created_userid uid, COUNT(*) n
    FROM nw_bbs_threads t
    LEFT JOIN nw_bbs_threads_content c ON c.tid = t.tid
    WHERE c.tid IS NULL
      AND NOT EXISTS (SELECT 1 FROM nw_bbs_posts p WHERE p.tid = t.tid)
    GROUP BY t.created_userid`);
  const active = new Set<number>();
  for (const r of await oldQuery(`SELECT DISTINCT created_userid uid FROM nw_bbs_posts WHERE created_userid > 0`)) {
    active.add(Number(r.uid));
  }
  for (const r of await oldQuery(`SELECT t.created_userid uid FROM nw_bbs_threads t
                                  JOIN nw_bbs_threads_content c ON c.tid = t.tid`)) {
    active.add(Number(r.uid));
  }
  const spam = new Set<number>();
  for (const r of shellOnly) {
    const uid = Number(r.uid);
    if (uid > 0 && !active.has(uid)) spam.add(uid);
  }
  return spam;
}

export function makeUsers(emo: EmoCtx): Migrator {
  return {
    name: 'users',
    async run() {
      const spamUsers = await loadSpamUsers();
      const maxRow = (await oldQuery(`SELECT MAX(uid) m FROM nw_user`))[0];
      const max = Number(maxRow?.m ?? 0);
      const cols = ['id', 'username', 'email', 'password_hash', 'group_id', 'gender', 'location',
        'homepage', 'signature_md', 'profile', 'post_count', 'digest_count', 'followers', 'fans',
        'credits', 'online_time', 'is_spam', 'status', 'created_at', 'last_visit_at',
        'last_post_at', 'raw'];
      let total = 0;
      for (let lo = 0; lo <= max; lo += config.batchSize) {
        const hi = lo + config.batchSize - 1;
        const rows = await oldQuery(
          `SELECT u.uid, u.username, u.email email_u, u.status, u.groupid, u.regdate,
                  w.email email_w, i.gender, i.location_text, i.homepage, i.bbs_sign, i.profile,
                  d.postnum, d.digest, d.follows, d.fans, d.onlinetime, d.lastvisit, d.lastpost,
                  d.credit1, d.credit2, d.credit3, d.credit4, d.credit5, d.credit6, d.credit7, d.credit8
           FROM nw_user u
           LEFT JOIN nw_windid_user w ON w.uid = u.uid
           LEFT JOIN nw_user_info i ON i.uid = u.uid
           LEFT JOIN nw_user_data d ON d.uid = u.uid
           WHERE u.uid BETWEEN ? AND ?`, [lo, hi]);
        if (rows.length === 0) continue;
        await upsertBatch('users', cols, rows.map((r) => ({
          id: r.uid,
          username: r.username,
          email: r.email_w || r.email_u || '',
          password_hash: null, // 红线：旧哈希不迁移，上线邮件重置
          group_id: r.groupid ?? 0,
          gender: r.gender ?? 0,
          location: r.location_text ?? '',
          homepage: r.homepage ?? '',
          signature_md: ubbToMarkdown(r.bbs_sign, emo) || null,
          profile: r.profile || null,
          post_count: r.postnum ?? 0,
          digest_count: r.digest ?? 0,
          followers: r.follows ?? 0,
          fans: r.fans ?? 0,
          credits: packCredits(r),
          online_time: r.onlinetime ?? 0,
          is_spam: spamUsers.has(Number(r.uid)) ? 1 : 0,
          status: r.status ?? 0,
          created_at: toDatetime(r.regdate),
          last_visit_at: toDatetime(r.lastvisit),
          last_post_at: toDatetime(r.lastpost),
          raw: j(r),
        })), ['id']);
        total += rows.length;
      }
      return { rows: total, note: `其中 ${spamUsers.size} 人标记 is_spam（仅发过广告空壳）` };
    },
  };
}
