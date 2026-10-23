/**
 * 抽取层：只负责从旧库读取原始行（只读守卫在 db.ts），不做任何业务转换。
 * 转换全部在 transform/ 的纯函数里完成，因此可以脱离数据库单测。
 */
import { oldQuery } from "./db.js";
import type { OldForum } from "./transform/forums.js";
import type { OldUser } from "./transform/users.js";
import type { MutedGroupMember, OldBan } from "./transform/restrictions.js";
import type { OldBelong, OldPermRow } from "./transform/authz.js";
import { MUTED_GID } from "./transform/legacy-groups.js";

export const extractForums = () =>
  oldQuery<OldForum>(
    `SELECT fid, parentid, type, name, descrip, vieworder, isshow, icon,
            allow_read, allow_post, allow_reply
     FROM nw_bbs_forum`,
  );

/** 被主题实际引用的前缀 id（150 个旧分类里只有约 94 个被用到） */
export async function extractUsedPrefixIds(): Promise<Set<number>> {
  const rows = await oldQuery<{ t: number }>(
    `SELECT DISTINCT topic_type AS t FROM nw_bbs_threads WHERE topic_type > 0`,
  );
  return new Set(rows.map((r) => Number(r.t)));
}

export const extractTopicTypes = () =>
  oldQuery<{ id: number; fid: number; name: string; vieworder: number }>(
    `SELECT id, fid, name, vieworder FROM nw_bbs_topic_type`,
  );

export const extractUsers = () =>
  oldQuery<OldUser>(
    `SELECT u.uid, u.username, u.email AS email_u, w.email AS email_w, u.regdate,
            d.lastvisit, i.gender, i.location_text, i.homepage, i.bbs_sign, i.profile,
            i.byear, i.bmonth, i.bday
     FROM nw_user u
     LEFT JOIN nw_windid_user w ON w.uid = u.uid
     LEFT JOIN nw_user_info i ON i.uid = u.uid
     LEFT JOIN nw_user_data d ON d.uid = u.uid`,
  );

/**
 * 广告账号判定（保守规则：只发过空壳广告帖、且全站无任何正常内容）。
 * 空壳 = 无首帖正文且无任何回帖。
 */
export async function extractSpamUids(): Promise<Set<number>> {
  const shellOnly = await oldQuery<{ uid: number }>(`
    SELECT t.created_userid AS uid
    FROM nw_bbs_threads t
    LEFT JOIN nw_bbs_threads_content c ON c.tid = t.tid
    WHERE c.tid IS NULL
      AND NOT EXISTS (SELECT 1 FROM nw_bbs_posts p WHERE p.tid = t.tid)
    GROUP BY t.created_userid`);
  const active = new Set<number>();
  for (const r of await oldQuery<{ uid: number }>(
    `SELECT DISTINCT created_userid AS uid FROM nw_bbs_posts WHERE created_userid > 0`,
  )) {
    active.add(Number(r.uid));
  }
  for (const r of await oldQuery<{ uid: number }>(
    `SELECT t.created_userid AS uid FROM nw_bbs_threads t
     JOIN nw_bbs_threads_content c ON c.tid = t.tid`,
  )) {
    active.add(Number(r.uid));
  }
  const spam = new Set<number>();
  for (const r of shellOnly) {
    const uid = Number(r.uid);
    if (uid > 0 && !active.has(uid)) spam.add(uid);
  }
  return spam;
}

/** uid → 最早发帖/回帖时间（修复缺失的注册时间） */
export async function extractFirstActivity(
  toDatetime: (n: number) => string | null,
): Promise<Map<number, string>> {
  const rows = await oldQuery<{ uid: number; t: number }>(
    `SELECT uid, MIN(t) AS t FROM (
       SELECT created_userid AS uid, created_time AS t FROM nw_bbs_threads WHERE created_time > 0
       UNION ALL
       SELECT created_userid AS uid, created_time AS t FROM nw_bbs_posts WHERE created_time > 0
     ) x WHERE uid > 0 GROUP BY uid`,
  );
  const out = new Map<number, string>();
  for (const r of rows) {
    const d = toDatetime(Number(r.t));
    if (d) out.set(Number(r.uid), d);
  }
  return out;
}

export const extractBans = () =>
  oldQuery<OldBan>(
    `SELECT id, uid, typeid, fid, end_time, created_userid, created_time, reason FROM nw_user_ban`,
  );

export const extractBelong = () =>
  oldQuery<OldBelong>(`SELECT uid, gid, endtime FROM nw_user_belong`);

export const extractMainGroups = () =>
  oldQuery<{ uid: number; gid: number }>(
    `SELECT uid, groupid AS gid FROM nw_user WHERE groupid > 0`,
  );

/** 禁止发言用户组的成员（主组 + 附加组） */
export async function extractMutedGroupMembers(): Promise<MutedGroupMember[]> {
  const main = await oldQuery<{ uid: number }>(`SELECT uid FROM nw_user WHERE groupid = ?`, [
    MUTED_GID,
  ]);
  const belong = await oldQuery<{ uid: number; endtime: number }>(
    `SELECT uid, endtime FROM nw_user_belong WHERE gid = ?`,
    [MUTED_GID],
  );
  return [...main.map((r) => ({ uid: r.uid, endtime: 0 })), ...belong];
}

export const extractPermissionRows = () =>
  oldQuery<OldPermRow>(`SELECT gid, rkey, rvalue FROM nw_user_permission_groups`);

export async function extractEmojiIds(): Promise<Set<number>> {
  const rows = await oldQuery<{ id: number }>(`SELECT emotion_id AS id FROM nw_common_emotion`);
  return new Set(rows.map((r) => Number(r.id)));
}
