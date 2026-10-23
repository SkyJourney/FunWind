import { oldQuery, upsertBatch, j } from "../db.js";
import { toDatetime, config, toDatetime as dt } from "../config.js";
import type { Migrator } from "../run.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** 附件元数据（文件本体不复制：新系统 /attachment/** 静态路由直指原目录） */
export const attachments: Migrator = {
  name: "attachments",
  async run() {
    const rows = await oldQuery(`SELECT aid, tid, pid, created_userid, name, type, size, path,
                                        ifthumb, width, height, hits, cost, special, created_time, descrip
                                 FROM nw_attachs_thread`);
    await upsertBatch(
      "attachments",
      [
        "id",
        "thread_id",
        "post_id",
        "uploader_id",
        "filename",
        "type",
        "size_kb",
        "path",
        "has_thumb",
        "width",
        "height",
        "downloads",
        "cost",
        "special",
        "created_at",
        "raw",
      ],
      rows.map((r) => ({
        id: r.aid,
        thread_id: Number(r.tid) > 0 ? r.tid : null,
        post_id: Number(r.pid) > 0 ? r.pid : null,
        uploader_id: r.created_userid ?? 0,
        filename: r.name ?? "",
        type: r.type ?? "",
        size_kb: r.size ?? 0,
        path: r.path ?? "",
        has_thumb: Number(r.ifthumb ?? 0) > 0 ? 1 : 0,
        width: r.width ?? 0,
        height: r.height ?? 0,
        downloads: r.hits ?? 0,
        cost: r.cost ?? 0,
        special: r.special ?? 0,
        created_at: toDatetime(r.created_time),
        raw: j(r),
      })),
      ["id"],
    );
    return { rows: rows.length, note: "文件不复制，/attachment/** 静态路由直指原目录" };
  },
};

/** 勋章定义 + 用户勋章（旧 medals 为 CSV 串，展开成行） */
export const medals: Migrator = {
  name: "medals",
  async run() {
    const info = await oldQuery(`SELECT medal_id, name, path, image, icon, descrip, medal_type,
                                        receive_type, medal_gids, award_type, award_condition,
                                        expired_days, isopen, vieworder
                                 FROM nw_medal_info`);
    await upsertBatch(
      "medals",
      [
        "id",
        "name",
        "path",
        "image",
        "icon",
        "description",
        "medal_type",
        "receive_type",
        "medal_gids",
        "award_type",
        "award_condition",
        "expired_days",
        "is_open",
        "vieworder",
        "raw",
      ],
      info.map((r) => ({
        id: r.medal_id,
        name: r.name,
        path: r.path ?? "",
        image: r.image ?? "",
        icon: r.icon ?? "",
        description: r.descrip ?? "",
        medal_type: r.medal_type ?? 1,
        receive_type: r.receive_type ?? 1,
        medal_gids: r.medal_gids ?? "",
        award_type: r.award_type ?? 1,
        award_condition: r.award_condition ?? 0,
        expired_days: r.expired_days ?? 0,
        is_open: Number(r.isopen ?? 1) > 0 ? 1 : 0,
        vieworder: r.vieworder ?? 0,
        raw: j(r),
      })),
      ["id"],
    );

    const known = new Set(info.map((r) => Number(r.medal_id)));
    const holders = await oldQuery(`SELECT uid, medals, counts, expired_time FROM nw_medal_user`);
    const pairs: Record<string, unknown>[] = [];
    let skipped = 0;
    for (const h of holders) {
      for (const mid of String(h.medals ?? "")
        .split(",")
        .map((s) => parseInt(s.trim(), 10))) {
        if (!Number.isFinite(mid)) continue;
        if (!known.has(mid)) {
          skipped++;
          continue;
        }
        pairs.push({
          user_id: h.uid,
          medal_id: mid,
          counts: h.counts ?? 0,
          expired_time: dt(h.expired_time),
        });
      }
    }
    await upsertBatch("user_medals", ["user_id", "medal_id", "counts", "expired_time"], pairs, [
      "user_id",
      "medal_id",
    ]);
    return {
      rows: info.length + pairs.length,
      note: `${info.length} 枚勋章 / ${pairs.length} 条持有记录（跳过未知勋章 ${skipped}）`,
    };
  },
};

/** 积分流水 */
export const credits: Migrator = {
  name: "credit_logs",
  async run() {
    const maxRow = (await oldQuery(`SELECT MAX(id) m FROM nw_credit_log`))[0];
    const max = Number(maxRow?.m ?? 0);
    let total = 0;
    for (let lo = 0; lo <= max; lo += config.batchSize * 5) {
      const hi = lo + config.batchSize * 5 - 1;
      const rows = await oldQuery(
        `SELECT id, ctype, affect, logtype, descrip, created_userid, created_time
         FROM nw_credit_log WHERE id BETWEEN ? AND ?`,
        [lo, hi],
      );
      if (rows.length === 0) continue;
      await upsertBatch(
        "credit_logs",
        ["id", "user_id", "credit_type", "delta", "log_type", "description", "created_at"],
        rows.map((r) => ({
          id: r.id,
          user_id: r.created_userid ?? 0,
          credit_type: r.ctype ?? "",
          delta: r.affect ?? 0,
          log_type: r.logtype ?? "",
          description: r.descrip ?? "",
          created_at: toDatetime(r.created_time),
        })),
        ["id"],
      );
      total += rows.length;
    }
    return { rows: total };
  },
};

/** 投票（poll / option / voter / thread 关联） */
export const polls: Migrator = {
  name: "polls",
  async run() {
    const threadMap = await oldQuery(`SELECT tid, poll_id FROM nw_app_poll_thread`);
    const tidOf = new Map(threadMap.map((r) => [Number(r.poll_id), Number(r.tid)]));

    const polls = await oldQuery(`SELECT poll_id, voter_num, isafter_view, isinclude_img,
                                         option_limit, expired_time, created_userid, created_time
                                  FROM nw_app_poll`);
    await upsertBatch(
      "polls",
      [
        "id",
        "thread_id",
        "voter_num",
        "isafter_view",
        "isinclude_img",
        "option_limit",
        "expired_time",
        "creator_id",
        "created_at",
        "raw",
      ],
      polls.map((r) => ({
        id: r.poll_id,
        thread_id: tidOf.get(Number(r.poll_id)) ?? null,
        voter_num: r.voter_num ?? 0,
        isafter_view: Number(r.isafter_view ?? 0) > 0 ? 1 : 0,
        isinclude_img: Number(r.isinclude_img ?? 0) > 0 ? 1 : 0,
        option_limit: r.option_limit ?? 0,
        expired_time: toDatetime(r.expired_time),
        creator_id: r.created_userid ?? 0,
        created_at: toDatetime(r.created_time),
        raw: j(r),
      })),
      ["id"],
    );

    const options = await oldQuery(`SELECT option_id, poll_id, voted_num, content, image
                                    FROM nw_app_poll_option`);
    await upsertBatch(
      "poll_options",
      ["id", "poll_id", "voted_num", "content", "image"],
      options.map((r) => ({
        id: r.option_id,
        poll_id: r.poll_id,
        voted_num: r.voted_num ?? 0,
        content: r.content ?? "",
        image: r.image ?? "",
      })),
      ["id"],
    );

    const voters = await oldQuery(`SELECT uid, poll_id, option_id, created_time
                                   FROM nw_app_poll_voter`);
    await upsertBatch(
      "poll_voters",
      ["poll_id", "option_id", "user_id", "created_at"],
      voters.map((r) => ({
        poll_id: r.poll_id,
        option_id: r.option_id,
        user_id: r.uid,
        created_at: toDatetime(r.created_time),
      })),
      ["poll_id", "option_id", "user_id"],
    );

    return {
      rows: polls.length + options.length + voters.length,
      note: `${polls.length} 投票 / ${options.length} 选项 / ${voters.length} 投票记录`,
    };
  },
};

/** 私信（消息 + 会话摘要） */
export const messages: Migrator = {
  name: "messages",
  async run() {
    const msgs = await oldQuery(`SELECT message_id, from_uid, to_uid, content, created_time
                                 FROM nw_windid_message`);
    await upsertBatch(
      "private_messages",
      ["id", "from_uid", "to_uid", "content", "created_at", "raw"],
      msgs.map((r) => ({
        id: r.message_id,
        from_uid: r.from_uid ?? 0,
        to_uid: r.to_uid ?? 0,
        content: r.content ?? null,
        created_at: toDatetime(r.created_time),
        raw: j(r),
      })),
      ["id"],
    );

    const dialogs = await oldQuery(`SELECT dialog_id, to_uid, from_uid, unread_count,
                                           message_count, last_message, modified_time
                                    FROM nw_windid_message_dialog`);
    await upsertBatch(
      "message_dialogs",
      ["id", "from_uid", "to_uid", "unread_count", "message_count", "last_message", "modified_at"],
      dialogs.map((r) => ({
        id: r.dialog_id,
        from_uid: r.from_uid ?? 0,
        to_uid: r.to_uid ?? 0,
        unread_count: r.unread_count ?? 0,
        message_count: r.message_count ?? 0,
        last_message: r.last_message ?? null,
        modified_at: toDatetime(r.modified_time),
      })),
      ["id"],
    );

    return {
      rows: msgs.length + dialogs.length,
      note: `${msgs.length} 私信 / ${dialogs.length} 会话`,
    };
  },
};

/** 附件文件存在性抽查（磁盘对账） */
export function checkAttachmentFiles(sample: string[]): number {
  let missing = 0;
  for (const p of sample) {
    if (!existsSync(join(config.attachmentDir, p))) missing++;
  }
  return missing;
}
