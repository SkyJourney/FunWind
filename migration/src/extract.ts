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
import type { OldPost, OldThread } from "./transform/content.js";

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

// ---------- B2：内容 / 积分 / 社交 ----------

/** 主题 + 首帖正文（threads_content 左连接：无正文的主题 content 为 NULL） */
export const extractThreads = () =>
  oldQuery<OldThread>(
    `SELECT t.tid, t.fid, t.topic_type, t.subject, t.digest, t.topped, t.special,
            t.disabled, t.ifshield, t.hits, t.created_time, t.created_username,
            t.created_userid, t.modified_time, c.content, (c.tid IS NOT NULL) AS has_content
     FROM nw_bbs_threads t
     LEFT JOIN nw_bbs_threads_content c ON c.tid = t.tid`,
  );

export const extractPosts = () =>
  oldQuery<OldPost>(
    `SELECT pid, tid, rpid, disabled, ifshield, content, created_time, created_username,
            created_userid, modified_time
     FROM nw_bbs_posts`,
  );

/** 空壳主题：无首帖正文且无任何回帖（广告洪泛），迁移为 state=spam、不生成首帖 */
export async function extractSpamTids(): Promise<Set<number>> {
  const rows = await oldQuery<{ tid: number }>(`
    SELECT t.tid FROM nw_bbs_threads t
    LEFT JOIN nw_bbs_threads_content c ON c.tid = t.tid
    WHERE c.tid IS NULL
      AND NOT EXISTS (SELECT 1 FROM nw_bbs_posts p WHERE p.tid = t.tid)`);
  return new Set(rows.map((r) => Number(r.tid)));
}

export const extractBuys = () =>
  oldQuery<{
    tid: number;
    pid: number;
    created_userid: number;
    created_time: number;
    cost: number;
  }>(`SELECT tid, pid, created_userid, created_time, cost FROM nw_bbs_threads_buy`);

export const extractAttachments = () =>
  oldQuery<{
    aid: number;
    tid: number;
    pid: number;
    name: string;
    type: string;
    size: number;
    hits: number;
    width: number;
    height: number;
    path: string;
    created_userid: number;
    created_time: number;
  }>(
    `SELECT aid, tid, pid, name, type, size, hits, width, height, path, created_userid, created_time
     FROM nw_attachs_thread`,
  );

export const extractTags = () =>
  oldQuery<{ tag_id: number; tag_name: string }>(`SELECT tag_id, tag_name FROM nw_tag`);

export const extractTagRelations = () =>
  oldQuery<{ tag_id: number; param_id: number; type_id: number; ifcheck: number }>(
    `SELECT tag_id, param_id, type_id, ifcheck FROM nw_tag_relation`,
  );

export const extractCreditBalances = () =>
  oldQuery<{ uid: number; credit1: number }>(`SELECT uid, credit1 FROM nw_user_data`);

export const extractBank = () =>
  oldQuery<{ uid: number; deposit: number; ddeposit: number }>(
    `SELECT uid, deposit, ddeposit FROM nw_app_bank`,
  );

export const extractPunchLogs = () =>
  oldQuery<{ id: number; uid: number; affect: number; created_time: number }>(
    `SELECT id, created_userid AS uid, affect, created_time
     FROM nw_credit_log WHERE logtype = 'punch' ORDER BY id`,
  );

export const extractMedalInfo = () =>
  oldQuery<{
    medal_id: number;
    name: string;
    image: string | null;
    icon: string | null;
    descrip: string | null;
    isopen: number;
    vieworder: number;
  }>(`SELECT medal_id, name, image, icon, descrip, isopen, vieworder FROM nw_medal_info`);

export const extractMedalUsers = () =>
  oldQuery<{ uid: number; medals: string; expired_time: number }>(
    `SELECT uid, medals, expired_time FROM nw_medal_user`,
  );

export const extractAttention = () =>
  oldQuery<{ uid: number; touid: number; created_time: number }>(
    `SELECT uid, touid, created_time FROM nw_attention`,
  );

export const extractForumJoins = () =>
  oldQuery<{ uid: number; fid: number; join_time: number }>(
    `SELECT uid, fid, join_time FROM nw_bbs_forum_user`,
  );

/** 点赞明细：typeid 1 = 主题（fromid = tid），2 = 回帖（fromid = pid） */
export const extractLikes = () =>
  oldQuery<{ uid: number; created_time: number; typeid: number; fromid: number }>(
    `SELECT l.uid, l.created_time, c.typeid, c.fromid
     FROM nw_like_log l JOIN nw_like_content c ON c.likeid = l.likeid`,
  );

export const extractPolls = () =>
  oldQuery<{
    poll_id: number;
    tid: number | null;
    voter_num: number;
    option_limit: number;
    isafter_view: number;
    expired_time: number;
    created_userid: number;
    created_time: number;
  }>(
    `SELECT p.poll_id, pt.tid, p.voter_num, p.option_limit, p.isafter_view, p.expired_time,
            p.created_userid, p.created_time
     FROM nw_app_poll p LEFT JOIN nw_app_poll_thread pt ON pt.poll_id = p.poll_id`,
  );

export const extractPollOptions = () =>
  oldQuery<{ option_id: number; poll_id: number; content: string }>(
    `SELECT option_id, poll_id, content FROM nw_app_poll_option ORDER BY option_id`,
  );

export const extractPollVotes = () =>
  oldQuery<{ uid: number; poll_id: number; option_id: number; created_time: number }>(
    `SELECT uid, poll_id, option_id, created_time FROM nw_app_poll_voter`,
  );

export const extractMessages = () =>
  oldQuery<{
    message_id: number;
    from_uid: number;
    to_uid: number;
    content: string;
    created_time: number;
  }>(
    `SELECT message_id, from_uid, to_uid, content, created_time FROM nw_windid_message
     ORDER BY created_time, message_id`,
  );

export const extractDialogs = () =>
  oldQuery<{ from_uid: number; to_uid: number; unread_count: number }>(
    `SELECT from_uid, to_uid, unread_count FROM nw_windid_message_dialog`,
  );
