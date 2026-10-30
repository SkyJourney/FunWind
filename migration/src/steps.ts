/**
 * 迁移步骤：每步 = extract → transform（纯函数）→ load（幂等）。
 * 步骤之间通过 Ctx 共享少量上下文（已迁用户 id、版块作用域授权等）。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config, toDatetime } from "./config.js";
import {
  bumpAutoIncrement,
  load,
  loadCompletedAccountDeletionIds,
  replaceAll,
  upsert,
} from "./db.js";
import {
  extractBans,
  extractBelong,
  extractEmojiIds,
  extractFirstActivity,
  extractForums,
  extractMainGroups,
  extractMutedGroupMembers,
  extractPermissionRows,
  extractSpamUids,
  extractTopicTypes,
  extractUsedPrefixIds,
  extractUsers,
} from "./extract.js";
import { maskEmail } from "./lib/pii.js";
import { head, loadUserIds, mapRows, type Step } from "./step-types.js";
import { TEAM_ROLES } from "./mapping/legacy-roles.js";
import { translateGlobalGrants, translateUserRoles } from "./transform/authz.js";
import { transformForums } from "./transform/forums.js";
import { plainConverter } from "./transform/plain.js";
import {
  filterCompletedAccountDeletions,
  filterCompletedDeletionNotes,
  legacyAvatarKey,
  transformUsers,
} from "./transform/users.js";
import { transformRestrictions } from "./transform/restrictions.js";

// ---------- 版块 ----------

export const forumsStep: Step = {
  name: "forums",
  async run(ctx) {
    const result = transformForums(await extractForums());
    // 板块图（M9.5 §3.4.3）：icon 非空的版块登记相对路径，文件管线入库后回填 icon_key
    ctx.forumIconSources.clear();
    for (const f of result.forums) {
      if (f.icon) ctx.forumIconSources.set(f.id, f.icon);
    }
    await upsert(
      "forums",
      [
        "id",
        "parent_id",
        "path",
        "depth",
        "kind",
        "name",
        "description",
        "sort_order",
        "read_policy",
        "write_policy",
        "is_listed",
      ],
      result.forums.map((f) => ({
        id: f.id,
        parent_id: f.parentId,
        path: f.path,
        depth: f.depth,
        kind: f.kind,
        name: f.name,
        description: f.description,
        sort_order: f.sortOrder,
        read_policy: f.readPolicy,
        write_policy: f.writePolicy,
        is_listed: f.isListed ? 1 : 0,
      })),
      ["id"],
    );
    await bumpAutoIncrement("forums");

    const by = <K extends string>(pick: (f: (typeof result.forums)[number]) => K) => {
      const m = new Map<K, number>();
      for (const f of result.forums) m.set(pick(f), (m.get(pick(f)) ?? 0) + 1);
      return mapRows(m);
    };
    const s = ctx.report.section("版块");
    s.line(
      `共 ${result.forums.length} 个；名称内嵌 HTML 样式已剥离 ${result.stats.styledNames} 个（颜色不保留）；回收站版块（及其子版块）不迁移：${head(result.stats.recycleDropped) || "无"}。`,
    );
    s.table(
      ["读策略", "版块数"],
      by((f) => f.readPolicy),
    );
    s.table(
      ["写策略", "版块数"],
      by((f) => f.writePolicy),
    );
    s.table(
      ["层级深度", "版块数"],
      by((f) => String(f.depth) as string),
    );
    s.line(
      `不出现在首页目录（is_listed=0）：${head(
        result.forums.filter((f) => !f.isListed).map((f) => f.id),
      )}`,
    );
    s.line(
      `restricted 版块的团队角色作用域授权 ${result.grants.length} 条（读 ${
        result.grants.filter((g) => g.permissionKey === "forum.read").length
      } / 写 ${result.grants.filter((g) => g.permissionKey === "forum.write").length}）。`,
    );
    if (result.stats.orphanParents.length || result.stats.cycles.length) {
      s.line(
        `⚠ 父版块缺失 ${head(result.stats.orphanParents)}；成环 ${head(result.stats.cycles)}（已降级为根）。`,
      );
    }
    s.table(
      ["白名单中无对应角色的旧 gid", "出现次数（restricted 版块内）"],
      mapRows(result.stats.unmappedGids),
    );
    return { rows: result.forums.length, note: `${result.grants.length} 条作用域授权` };
  },
};

export const forumPrefixesStep: Step = {
  name: "forum_prefixes",
  async run(ctx) {
    const [all, used] = [await extractTopicTypes(), await extractUsedPrefixIds()];
    const rows = all.filter((r) => used.has(Number(r.id)));
    await load(
      "forum_prefixes",
      ["id", "forum_id", "name", "sort_order"],
      rows.map((r) => ({
        id: r.id,
        forum_id: r.fid,
        name: String(r.name ?? "").trim() || `分类${r.id}`,
        sort_order: r.vieworder ?? 0,
      })),
      ["id"],
    );
    await bumpAutoIncrement("forum_prefixes");
    ctx.report
      .section("主题前缀")
      .line(
        `旧分类 ${all.length} 个，被主题实际引用 ${rows.length} 个，其余 ${all.length - rows.length} 个丢弃。`,
      );
    return { rows: rows.length };
  },
};

// ---------- 用户 ----------

export const usersStep: Step = {
  name: "users",
  async run(ctx) {
    const [oldUsers, excludeUids, firstActivity, emojiIds] = [
      await extractUsers(),
      await extractSpamUids(),
      await extractFirstActivity(toDatetime),
      await extractEmojiIds(),
    ];

    // 签名里不允许出现门控：转换后丢弃门控占位与隐藏内容
    const convertSignature = plainConverter(emojiIds);

    const result = transformUsers(oldUsers, {
      excludeUids,
      firstActivity,
      avatarExists: (uid) => existsSync(join(config.attachmentDir, legacyAvatarKey(uid))),
      convertSignature,
      fallbackCreatedAt: "2010-01-01 00:00:00",
    });

    const completedDeletionIds = await loadCompletedAccountDeletionIds();
    const preserved = filterCompletedAccountDeletions(
      result.users,
      result.profiles,
      completedDeletionIds,
    );
    const n = filterCompletedDeletionNotes(result.notes, completedDeletionIds);
    const avatarCountToImport = preserved.profiles.filter(
      (profile) => profile.avatarSource !== null,
    ).length;
    await upsert(
      "users",
      [
        "id",
        "username",
        "username_key",
        "email",
        "email_key",
        "password_hash",
        "email_verified_at",
        "state",
        "created_at",
        "last_login_at",
      ],
      preserved.users.map((u) => ({
        id: u.id,
        username: u.username,
        username_key: u.usernameKey,
        email: u.email,
        email_key: u.emailKey,
        password_hash: u.passwordHash,
        email_verified_at: u.emailVerifiedAt,
        state: u.state,
        created_at: u.createdAt,
        last_login_at: u.lastLoginAt,
      })),
      ["id"],
    );
    await upsert(
      "user_profiles",
      ["user_id", "bio", "location", "website", "gender", "birthday", "signature_md"],
      preserved.profiles.map((p) => ({
        user_id: p.userId,
        bio: p.bio,
        location: p.location,
        website: p.website,
        gender: p.gender,
        birthday: p.birthday,
        signature_md: p.signatureMd,
      })),
      ["user_id"],
    );
    await bumpAutoIncrement("users");
    ctx.userIds = new Set(preserved.users.map((u) => u.id));
    ctx.avatarSources = new Map(
      preserved.profiles.flatMap((p) =>
        p.avatarSource ? [[p.userId, p.avatarSource] as const] : [],
      ),
    );

    const s = ctx.report.section("用户");
    s.line(
      `旧站用户 ${result.users.length} 人；已完成注销 ${preserved.skipped} 人保留匿名终态、不回填旧资料；spam 账号 ${n.excluded} 个不迁移；入库头像 ${avatarCountToImport} 人；密码一律不迁移（password_hash=NULL，走邮件认领/重置）。`,
    );
    s.bullets([
      `用户名归一化冲突 ${n.usernameCollisions.length} 个${
        n.usernameCollisions.length
          ? "：" + n.usernameCollisions.map((c) => `${c.uid}→${c.to}`).join("、")
          : ""
      }`,
      `用户名为空 ${n.emptyUsernames.length} 个`,
      `注册时间缺失已修复 ${n.createdAtRepaired.length} 个：${
        n.createdAtRepaired.map((r) => `${r.uid}（${r.source}）→ ${r.to}`).join("；") || "无"
      }`,
    ]);
    // 公开报告只放 uid 与脱敏邮箱；完整邮箱进私有待办清单（gitignore，不入库）
    s.line(`### 待站长处理：非法邮箱（已置空）${n.invalidEmails.length} 个`);
    s.table(
      ["uid", "原邮箱（脱敏）"],
      n.invalidEmails.map((e) => [e.uid, maskEmail(e.email)]),
    );
    s.line(`### 待站长处理：重复邮箱 ${n.duplicateEmails.length} 组（保留最早注册者，其余置空）`);
    s.table(
      ["邮箱（脱敏）", "保留 uid", "已清空 uid"],
      n.duplicateEmails.map((d) => [maskEmail(d.email), d.keptUid, d.clearedUids.join("、")]),
    );
    s.line(
      "完整邮箱清单见本机 `migration/reports/migration-v2-todo-pii.md`（含个人信息，已 gitignore，不入库）。",
    );
    const priv = ctx.privateReport.section("非法邮箱（已置空）");
    priv.table(
      ["uid", "原邮箱"],
      n.invalidEmails.map((e) => [e.uid, e.email]),
    );
    const privDup = ctx.privateReport.section("重复邮箱（保留最早注册者，其余置空）");
    privDup.table(
      ["邮箱", "保留 uid", "已清空 uid"],
      n.duplicateEmails.map((d) => [d.email, d.keptUid, d.clearedUids.join("、")]),
    );
    return {
      rows: preserved.users.length,
      note: `${n.excluded} spam 未迁 / ${avatarCountToImport} 头像待入库 / ${preserved.skipped} 注销用户保留终态`,
    };
  },
};

// ---------- 限制 ----------

export const restrictionsStep: Step = {
  name: "restrictions",
  async run(ctx) {
    const result = transformRestrictions(
      await extractBans(),
      await extractMutedGroupMembers(),
      await loadUserIds(ctx),
      ctx.asOf,
    );
    await load(
      "user_restrictions",
      [
        "id",
        "user_id",
        "kind",
        "scope_id",
        "reason",
        "starts_at",
        "ends_at",
        "created_by",
        "created_at",
      ],
      result.rows.map((r) => ({
        id: r.id,
        user_id: r.userId,
        kind: r.kind,
        scope_id: r.scopeId,
        reason: r.reason,
        starts_at: r.startsAt,
        ends_at: r.endsAt,
        created_by: r.createdBy,
        created_at: r.createdAt,
      })),
      ["id"],
    );
    await bumpAutoIncrement("user_restrictions");
    const st = result.stats;
    const kinds = new Map<string, number>();
    for (const r of result.rows) kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + 1);
    const s = ctx.report.section("用户限制");
    s.line(
      `旧封禁 ${st.fromBans} 条 + 禁止发言组 ${st.fromGroup} 人 = ${result.rows.length} 条；` +
        `已过期丢弃 ${st.expiredSkipped}；与现有禁言重复的禁言组成员 ${st.groupDeduped}；用户已不存在 ${st.orphanUsers}；类型未知 ${st.unknownType}。`,
    );
    s.table(["类型", "条数"], mapRows(kinds));
    s.line(
      "说明：旧站 `nw_user_ban.typeid` 1/2/4 = 禁言/禁头像/禁签名，**从无「禁止登录」类封禁**；禁止发言组成员翻译为永久禁言。",
    );
    return { rows: result.rows.length };
  },
};

// ---------- 权限 ----------

export const authzStep: Step = {
  name: "authz",
  async run(ctx) {
    const [permRows, belong, mainGroups] = [
      await extractPermissionRows(),
      await extractBelong(),
      await extractMainGroups(),
    ];
    // 团队角色是站点数据：由迁移创建（零数据部署不带任何团队角色）
    await upsert(
      "roles",
      ["key", "name", "kind", "description"],
      TEAM_ROLES.map((t) => ({
        key: t.key,
        name: t.name,
        kind: "custom",
        description: t.description,
      })),
      ["key"],
    );
    const global = translateGlobalGrants(permRows);
    const roles = translateUserRoles(belong, mainGroups, await loadUserIds(ctx), ctx.asOf);
    // restricted 版块的团队角色读/写授权由版块白名单推导（纯函数，可独立运行本步骤）
    const forumGrants = transformForums(await extractForums()).grants;

    const grantRows = [
      ...global.grants.map((g) => ({
        role_key: g.roleKey,
        permission_key: g.permissionKey,
        scope_id: 0,
      })),
      ...forumGrants.map((g) => ({
        role_key: g.roleKey,
        permission_key: g.permissionKey,
        scope_id: g.scopeId,
      })),
    ];
    await replaceAll("role_grants", ["role_key", "permission_key", "scope_id"], grantRows);
    await replaceAll(
      "user_roles",
      ["user_id", "role_key", "scope_id", "expires_at", "granted_by", "granted_at"],
      roles.rows.map((r) => ({
        user_id: r.userId,
        role_key: r.roleKey,
        scope_id: r.scopeId,
        expires_at: r.expiresAt,
        granted_by: r.grantedBy,
        granted_at: r.grantedAt,
      })),
    );

    const gs = global.stats;
    const s = ctx.report.section("权限翻译");
    s.line(
      `全局授权 ${global.grants.length} 条 + 版块作用域授权 ${forumGrants.length} 条；用户角色绑定 ${roles.rows.length} 条。` +
        `（翻译类表采用「替换式加载」：整体由旧数据推导，重跑不遗留过期授权。）`,
    );
    const perRole = new Map<string, number>();
    for (const g of global.grants) perRole.set(g.roleKey, (perRole.get(g.roleKey) ?? 0) + 1);
    s.table(["角色", "全局授权数"], mapRows(perRole));
    const held = new Map<string, number>();
    for (const r of roles.rows) held.set(r.roleKey, (held.get(r.roleKey) ?? 0) + 1);
    s.table(["角色", "持有人数"], mapRows(held));
    s.line("### 旧权限键的去向");
    s.bullets([
      `版块读权限（allow_read）交由 read_policy 表达，不翻译为授权：${gs.skippedPolicy} 行`,
      `版主操作键（operate_thread）不翻译：对普通会员只是设置数组，版主权限只能经 forum.moderate 作用域授权获得：${gs.skippedModeration} 行`,
      `非开关键出现数组值（设置而非开关，未翻译）：${[...gs.unexpectedArrays].map(([k, n]) => `${k}×${n}`).join("、") || "无"}`,
      `条件参数型旧键（转 ABAC，M6 消费）：${[...gs.conditionKeys].map(([k, n]) => `${k}×${n}`).join("、") || "无"}`,
      `词汇表无对应的旧键（多为已取消功能）：${[...gs.unmappedKeys].map(([k, n]) => `${k}×${n}`).join("、") || "无"}`,
      `禁止发言组的权限行（改走 user_restrictions）：${gs.skippedMutedGroup} 行`,
      `PHP 序列化值解析失败：${gs.parseErrors.length} 行${
        gs.parseErrors.length
          ? "：" + gs.parseErrors.map((e) => `gid${e.gid}/${e.rkey}`).join("、")
          : ""
      }`,
    ]);
    s.line("### 未映射的旧 gid（站长已决策：已删除组的成员/权限不恢复）");
    const unmappedAll = [
      ...new Set([...gs.unmappedGids.keys(), ...roles.stats.unmappedGids.keys()]),
    ].sort((a, b) => a - b);
    s.table(
      ["旧 gid", "权限行数", "用户绑定数"],
      unmappedAll.map((gid) => [
        gid,
        gs.unmappedGids.get(gid) ?? 0,
        roles.stats.unmappedGids.get(gid) ?? 0,
      ]),
    );
    s.line("### 会员权限的「最宽并集」（只有部分会员组开启的权限点）");
    s.table(
      ["权限点", "开启的会员组", "未开启的会员组"],
      gs.memberPartial.map((p) => [p.permissionKey, p.granted.join(","), p.missing.join(",")]),
    );
    s.bullets([
      `用户角色：隐式角色（会员/游客）不落行 ${roles.stats.implicitSkipped}；已过期丢弃 ${roles.stats.expiredSkipped}；用户已不存在 ${roles.stats.orphanUsers}`,
    ]);
    return { rows: grantRows.length + roles.rows.length };
  },
};

// ---------- 站点设置 ----------

export const settingsStep: Step = {
  name: "settings",
  async run(ctx) {
    await upsert(
      "site_settings",
      ["key", "value", "updated_at"],
      [
        {
          key: "points.name",
          value: JSON.stringify({ name: "青翼币" }),
          updated_at: ctx.asOf,
        },
      ],
      ["key"],
    );
    ctx.report.section("站点设置").line("积分显示名设为「青翼币」；注册模式保持默认（邀请制）。");
    return { rows: 1 };
  },
};
