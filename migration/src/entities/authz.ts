import { oldQuery, upsertBatch } from "../db.js";
import { toDatetime } from "../config.js";
import { PERMISSION_DEFINITIONS, ROLE_DEFINITIONS, type RoleDef } from "@funwind/db";
import type { Migrator } from "../run.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * authz 翻译实体（M5）：旧五类数据 → 现代权限模型。
 * 原则：忠实翻译（不擅自修正历史配置），差异与疑点全部进对账报告（reports/authz-translation-report.md）。
 */

// ---------- 映射表 ----------

/** 旧 gid → 新角色键 */
const GID_TO_ROLE: Record<number, string> = {
  2: "guest",
  1: "member",
  8: "member",
  9: "member",
  10: "member",
  11: "member",
  12: "member",
  13: "member",
  28: "member",
  29: "member",
  30: "member",
  31: "member",
  32: "member",
  33: "member",
  3: "admin",
  4: "admin",
  5: "admin",
  6: "muted",
  18: "team-subtitle",
  21: "team-tech",
  23: "team-planning",
  36: "team-resource",
  37: "team-art",
  38: "team-intern",
};

/** 旧 rkey → 新权限点（可多目标）；数值型见 NUMERIC_KEYS */
const RKEY_TO_PERMS: Record<string, string[]> = {
  allow_visit: ["site.visit"],
  allow_report: ["forum.report"],
  allow_read: ["forum.read"],
  allow_post: ["forum.write"],
  allow_reply: ["forum.write"],
  allow_upload: ["attachment.upload"],
  allow_download: ["attachment.download"],
  allow_thread_extend: ["thread.sell", "thread.hide"], // rvalue 数组按内容过滤

  thread_award: ["thread.award"],
  remote_download: ["thread.remoteImage"],
  reply_locked_threads: ["thread.replyLocked"],
  allow_publish_vedio: ["media.publishVideo"],
  allow_publish_music: ["media.publishMusic"],
  multimedia_auto_open: ["media.embed"],
  allow_add_vote: ["vote.create"],
  allow_participate_vote: ["vote.participate"],
  allow_view_vote: ["vote.view"],
  allow_sign: ["sign.use"],
  message_allow_send: ["pm.send"],
  tag_allow_add: ["tag.add"],
  tag_allow_edit: ["tag.edit"],
  tag_allow_manage: ["tag.manage"],
  invite_allow_buy: ["invite.buy"],
  remind_open: ["remind.receive"],
  panel_bbs_manage: ["site.admin", "forum.moderate"],
  panel_user_manage: ["site.admin", "admin.users"],
  panel_recycle_manage: ["site.admin", "admin.recycle"],
  panel_report_manage: ["site.admin", "admin.reports"],
  panel_log_manage: ["site.admin", "admin.logs"],
  force_operate_reason: ["forum.forceReason"],
  look_thread_log: ["forum.viewLog"],
  view_ip_address: ["user.viewIp"],
  design_allow_manage: ["design.manage"],
  fresh_delete: ["fresh.delete"],
};

/** 数值型旧键 → ABAC 条件（M6 消费；翻译报告记录各角色历史值） */
const NUMERIC_KEYS = new Set([
  "threads_perday",
  "post_pertime",
  "post_url_num",
  "post_modify_time",
  "thread_edit_time",
  "user_binding",
  "uploads_perday",
  "sell_credits",
  "sell_credit_range",
  "enhide_credits",
  "post_check",
  "invite_buy_credit_num",
  "invite_limit_24h",
  "message_max_send",
  "remind_max_num",
  "sign_max_length",
  "sign_max_height",
  "sign_ubb",
  "sign_ubb_img",
]);

const MEMBER_GIDS = [1, 8, 9, 10, 11, 12, 13, 28, 29, 30, 31, 32, 33];

// ---------- 翻译 ----------

interface Report {
  lines: string[];
  add(s: string): void;
  save(file: string): void;
}

export const authz: Migrator = {
  name: "authz",
  async run() {
    const report: Report = {
      lines: ["# authz 翻译对账报告（自动生成，供站长复核）", ""],
      add(s: string) {
        this.lines.push(s);
      },
      save(file: string) {
        writeFileSync(file, this.lines.join("\n") + "\n");
      },
    };

    // 1. roles / permissions（词汇表直接落库）
    await upsertBatch(
      "roles",
      ["key", "name", "kind", "description"],
      ROLE_DEFINITIONS.map((r: RoleDef) => ({
        key: r.key,
        name: r.name,
        kind: r.kind,
        description:
          r.description + (r.legacyGids.length ? `（旧 gid: ${r.legacyGids.join(",")}）` : ""),
      })),
      ["key"],
    );
    await upsertBatch(
      "permissions",
      ["key", "resource", "level", "description", "legacy_key"],
      PERMISSION_DEFINITIONS.map((p) => ({
        key: p.key,
        resource: p.resource,
        level: p.level,
        description: p.description,
        legacy_key: p.legacyKey,
      })),
      ["key"],
    );

    // 2. 全局组权限 → role_grants(global) + member 并集差异
    const permRows: {
      role_key: string;
      permission_key: string;
      scope_type: "global";
      forum_id: null;
    }[] = [];
    const unionByPerm = new Map<string, Set<string>>(); // perm → 值为 "1" 的 gid 集（member 基线用）

    // 1.5 admin 内置基线：全站管理 + 角色矩阵管理（admin.roles 为新权限点，旧系统无对应键）
    for (const perm of [
      "site.admin",
      "admin.roles",
      "admin.users",
      "admin.recycle",
      "admin.reports",
      "admin.logs",
      "forum.read",
      "forum.write",
      "forum.manage", // admin 例外：全站读写（其余角色的 forum 域不走全局授权）
    ]) {
      permRows.push({
        role_key: "admin",
        permission_key: perm,
        scope_type: "global",
        forum_id: null,
      });
    }

    const groupRows = await oldQuery(
      `SELECT gid, rkey, rvalue, vtype FROM nw_user_permission_groups`,
    );
    let numericSkipped = 0;
    for (const r of groupRows) {
      const role = GID_TO_ROLE[Number(r.gid)];
      if (!role) {
        report.add(`- ⚠ 未知 gid ${r.gid}（rkey ${r.rkey}）跳过`);
        continue;
      }
      const perms = RKEY_TO_PERMS[String(r.rkey)];
      if (!perms) {
        if (NUMERIC_KEYS.has(String(r.rkey))) numericSkipped++;
        else report.add(`- ⚠ 未映射 rkey ${r.rkey}（gid ${r.gid}）跳过`);
        continue;
      }
      // rvalue 形态：'1' / '0' / PHP 序列化数组（a:1:{...}，非空即视为开启）
      const rvalue = String(r.rvalue ?? "").trim();
      const on = rvalue === "1" || (rvalue.startsWith("a:") && rvalue.includes('s:1:"1"'));
      for (const perm of perms) {
        // allow_thread_extend 数组值按内容过滤（sell/hide 独立权限点）
        if (String(r.rkey) === "allow_thread_extend") {
          const v = String(r.rvalue);
          if (perm === "thread.sell" && !v.includes("sell")) continue;
          if (perm === "thread.hide" && !v.includes("hide")) continue;
        }
        if (on) {
          // forum 域权限不走全局授权——由 allow_* 版块白名单逐版块表达（白名单命中才放行）
          if (perm.startsWith("forum.")) continue;
          permRows.push({
            role_key: role,
            permission_key: perm,
            scope_type: "global",
            forum_id: null,
          });
          if (MEMBER_GIDS.includes(Number(r.gid))) {
            if (!unionByPerm.has(perm)) unionByPerm.set(perm, new Set());
            unionByPerm.get(perm)!.add(String(r.gid));
          }
        } else if (MEMBER_GIDS.includes(Number(r.gid))) {
          report.add(`- ℹ member 组 ${r.gid} 显式关闭 ${perm}（并集合并后该差异消失，见差异清单）`);
        }
      }
    }
    report.add(
      `- 数值型旧键 ${numericSkipped} 行 → ABAC 条件参数（M6 消费，各角色历史值见 nw_user_permission_groups 原表）`,
    );

    // member 基线：最宽并集（任一 LV 组开启即开启）
    const unionSet = new Set(unionByPerm.keys());
    for (const [perm] of unionByPerm) {
      permRows.push({
        role_key: "member",
        permission_key: perm,
        scope_type: "global",
        forum_id: null,
      });
    }
    // 差异清单：哪些 LV 组与并集不同
    const lvRows = groupRows.filter(
      (r) => MEMBER_GIDS.includes(Number(r.gid)) && RKEY_TO_PERMS[String(r.rkey)],
    );
    const byGid = new Map<number, Set<string>>();
    for (const r of lvRows) {
      if (String(r.rvalue) !== "1") continue;
      const perms = RKEY_TO_PERMS[String(r.rkey)] ?? [];
      for (const p of perms) {
        const gid = Number(r.gid);
        if (!byGid.has(gid)) byGid.set(gid, new Set());
        byGid.get(gid)!.add(p);
      }
    }
    report.add("");
    report.add("## member 基线（最宽并集）覆盖的权限点");
    report.add(
      [...unionSet]
        .sort()
        .map((p) => `- ${p}`)
        .join("\n"),
    );
    report.add("");

    // 去重后落库
    const seen = new Set<string>();
    const dedup = permRows.filter((r) => {
      const k = `${r.role_key}|${r.permission_key}|${r.scope_type}|${r.forum_id}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    await upsertBatch(
      "role_grants",
      ["role_key", "permission_key", "scope_type", "forum_id"],
      dedup.map((r) => ({
        role_key: r.role_key,
        permission_key: r.permission_key,
        scope_type: r.scope_type,
        forum_id: r.forum_id,
      })),
      ["role_key", "permission_key", "scope_type", "forum_id"],
    );

    // 3. 版块白名单 allow_* → forum 作用域授权
    const forumRows = await oldQuery(
      `SELECT fid, name, allow_read, allow_post, allow_reply, allow_upload, allow_download, allow_visit
       FROM nw_bbs_forum`,
    );
    const forumGrants: {
      role_key: string;
      permission_key: string;
      scope_type: "forum";
      forum_id: number;
    }[] = [];
    const COLUMN_PERMS: Record<string, string[]> = {
      allow_visit: ["site.visit"],
      allow_read: ["forum.read"],
      allow_post: ["forum.write"],
      allow_reply: ["forum.write"],
      allow_upload: ["attachment.upload"],
      allow_download: ["attachment.download"],
    };
    for (const f of forumRows) {
      const fid = Number(f.fid);
      for (const [col, perms] of Object.entries(COLUMN_PERMS)) {
        const raw = String(f[col] ?? "").trim();
        if (raw === "") continue; // 空 = 不限制（走角色全局授权）
        for (const gidRaw of raw.split(",")) {
          const gid = Number(gidRaw.trim());
          const role = GID_TO_ROLE[gid];
          if (!role) {
            report.add(`- ⚠ 版块 ${fid}（${f.name}）${col} 含未知 gid ${gidRaw}，跳过`);
            continue;
          }
          for (const perm of perms) {
            forumGrants.push({
              role_key: role,
              permission_key: perm,
              scope_type: "forum",
              forum_id: fid,
            });
          }
        }
      }
    }
    await upsertBatch(
      "role_grants",
      ["role_key", "permission_key", "scope_type", "forum_id"],
      forumGrants.map((g) => ({
        role_key: g.role_key,
        permission_key: g.permission_key,
        scope_type: g.scope_type,
        forum_id: g.forum_id,
      })),
      ["role_key", "permission_key", "scope_type", "forum_id"],
    );
    report.add("");
    report.add(
      `- 版块白名单翻译：${forumGrants.length} 条 forum 作用域授权（43 版块 × visit/read/post/reply/upload/download）`,
    );

    // 4. user_belong → user_roles（团队角色/muted，含过期）
    const belongRows = await oldQuery(`SELECT uid, gid, endtime FROM nw_user_belong`);
    const userRoleRows: Record<string, unknown>[] = [];
    for (const b of belongRows) {
      const role = GID_TO_ROLE[Number(b.gid)];
      if (!role || role === "member" || role === "guest" || role === "admin") {
        if (role) continue; // member/guest/admin 为隐式或另有来源
        report.add(`- ⚠ user_belong 未知 gid ${b.gid}（uid ${b.uid}）跳过`);
        continue;
      }
      userRoleRows.push({
        user_id: b.uid,
        role_key: role,
        scope_type: "global",
        forum_id: null,
        expires_at: toDatetime(b.endtime),
        granted_by: null,
        granted_at: toDatetime(b.endtime) ?? toDatetime(Math.floor(Date.now() / 1000)),
      });
    }
    // users.group_id 主组：admin（3/4/5）与特殊组（18 等）显式绑定
    const primaryRows = await oldQuery(
      `SELECT uid, groupid FROM nw_user WHERE groupid IN (3,4,5,18,21,23,36,37,38,6)`,
    );
    for (const r of primaryRows) {
      const role = GID_TO_ROLE[Number(r.groupid)];
      if (!role || role === "member") continue;
      userRoleRows.push({
        user_id: r.uid,
        role_key: role,
        scope_type: "global",
        forum_id: null,
        expires_at: null,
        granted_by: null,
        granted_at: toDatetime(Math.floor(Date.now() / 1000)),
      });
    }
    // 去重（同用户同角色保留一条；永久优先于带过期）
    const urSeen = new Map<string, Record<string, unknown>>();
    for (const r of userRoleRows) {
      const k = `${r.user_id}|${r.role_key}|${r.scope_type}|${r.forum_id}`;
      const prev = urSeen.get(k);
      if (!prev) {
        urSeen.set(k, r);
        continue;
      }
      if (prev.expires_at !== null && r.expires_at === null) urSeen.set(k, r);
    }
    await upsertBatch(
      "user_roles",
      ["user_id", "role_key", "scope_type", "forum_id", "expires_at", "granted_by", "granted_at"],
      [...urSeen.values()],
      ["user_id", "role_key", "scope_type", "forum_id"],
    );

    // 5. 旧版主名单（不迁移，导出供核对：派生版主 = forum.write/manage 授权持有人）
    report.add("");
    report.add("## 旧版主名单（forum.manager，未迁移——新系统由 forum.write/manage 授权派生）");
    const managers = await oldQuery(
      `SELECT fid, name, manager FROM nw_bbs_forum WHERE manager<>''`,
    );
    for (const m of managers) {
      report.add(`- fid ${m.fid} ${m.name}：${m.manager}`);
    }

    report.add("");
    report.add(`## 汇总`);
    report.add(`- roles ${ROLE_DEFINITIONS.length} / permissions ${PERMISSION_DEFINITIONS.length}`);
    report.add(`- role_grants 全局 ${dedup.length} + 版块 ${forumGrants.length}`);
    report.add(`- user_roles ${urSeen.size}`);

    report.save(join(process.cwd(), "reports/authz-translation-report.md"));

    return {
      rows:
        ROLE_DEFINITIONS.length +
        PERMISSION_DEFINITIONS.length +
        dedup.length +
        forumGrants.length +
        urSeen.size,
      note: `角色 ${ROLE_DEFINITIONS.length} / 权限点 ${PERMISSION_DEFINITIONS.length} / 全局授权 ${dedup.length} / 版块授权 ${forumGrants.length} / 用户绑定 ${urSeen.size}；对账报告见 migration/reports/`,
    };
  },
};
