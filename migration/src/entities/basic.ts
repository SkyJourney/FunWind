import { oldQuery, upsertBatch, j } from "../db.js";
import type { Migrator } from "../run.js";

/** 表情分类 + 表情（[s:N] 渲染映射的数据源） */
export const emoticons: Migrator = {
  name: "emoticons",
  async run() {
    await upsertBatch(
      "emoticon_categories",
      ["id", "name", "folder", "apps", "orderid", "is_open"],
      (
        await oldQuery(`SELECT category_id, category_name, emotion_folder, emotion_apps, orderid, isopen
                       FROM nw_common_emotion_category`)
      ).map((r) => ({
        id: r.category_id,
        name: r.category_name,
        folder: r.emotion_folder,
        apps: r.emotion_apps ?? "",
        orderid: r.orderid ?? 0,
        is_open: Number(r.isopen ?? 0) > 0 ? 1 : 0,
      })),
      ["id"],
    );

    const rows =
      await oldQuery(`SELECT emotion_id, category_id, emotion_folder, emotion_icon, isused
                                 FROM nw_common_emotion`);
    await upsertBatch(
      "emoticons",
      ["id", "category_id", "folder", "icon", "is_used"],
      rows.map((r) => ({
        id: r.emotion_id,
        category_id: r.category_id,
        folder: r.emotion_folder,
        icon: r.emotion_icon,
        is_used: Number(r.isused ?? 0) > 0 ? 1 : 0,
      })),
      ["id"],
    );
    return { rows: rows.length, note: `${rows.length} 枚表情，[s:N] 直映射` };
  },
};

/** 用户组（魔界等级体系 + 特殊组） */
export const groups: Migrator = {
  name: "groups",
  async run() {
    const rows = await oldQuery(`SELECT gid, name, type, points, image FROM nw_user_groups`);
    await upsertBatch(
      "groups",
      ["id", "name", "type", "points", "image", "raw"],
      rows.map((r) => ({
        id: r.gid,
        name: r.name,
        type: r.type,
        points: r.points ?? 0,
        image: r.image ?? "",
        raw: j(r),
      })),
      ["id"],
    );
    return { rows: rows.length };
  },
};

/** 版块树：剥离名称内嵌 HTML 到 name_style */
export const forums: Migrator = {
  name: "forums",
  async run() {
    const rows = await oldQuery(`SELECT f.fid, f.parentid, f.type, f.name, f.descrip, f.summary,
                                        f.vieworder, f.isshow, f.manager, f.icon, f.logo
                                 FROM nw_bbs_forum f`);
    const stats = new Map<number, { threads: number; posts: number }>();
    for (const s of await oldQuery(`SELECT fid, threads, posts FROM nw_bbs_forum_statistics`)) {
      stats.set(Number(s.fid), { threads: Number(s.threads ?? 0), posts: Number(s.posts ?? 0) });
    }

    let styled = 0;
    const out = rows.map((r) => {
      let name = String(r.name ?? "");
      let style = "";
      const m = name.match(/^<span[^>]*style="([^"]*)"[^>]*>(.*)<\/span>$/s);
      if (m) {
        style = m[1];
        name = m[2];
        styled++;
      }
      const st = stats.get(Number(r.fid));
      return {
        id: r.fid,
        parent_id: r.parentid ?? 0,
        type: ["category", "forum", "sub", "sub2"].includes(r.type) ? r.type : "forum",
        name,
        name_style: style,
        description: r.descrip || null,
        summary: r.summary || null,
        vieworder: r.vieworder ?? 0,
        is_show: Number(r.isshow ?? 1) > 0 ? 1 : 0,
        managers: j(
          String(r.manager ?? "")
            .split(/[\s,，]+/)
            .filter(Boolean),
        ),
        icon: r.icon ?? "",
        logo: r.logo ?? "",
        thread_count: st?.threads ?? 0,
        post_count: st?.posts ?? 0,
        raw: j(r),
      };
    });
    await upsertBatch(
      "forums",
      [
        "id",
        "parent_id",
        "type",
        "name",
        "name_style",
        "description",
        "summary",
        "vieworder",
        "is_show",
        "managers",
        "icon",
        "logo",
        "thread_count",
        "post_count",
        "raw",
      ],
      out,
      ["id"],
    );
    return { rows: out.length, note: `${styled} 个版块名剥离了内嵌样式` };
  },
};
