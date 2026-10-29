/**
 * 迁移 v2 对账：旧库（只读） ⇄ 新库。
 * 原则：期望值尽量用与迁移实现**不同的路径**独立推导（直接对旧库写 SQL），
 * 避免「实现和检查共用同一段逻辑，错了也是一致的」。
 * 输出：控制台 + docs/reports/migration-v2-verify.md（确定性，入库）。
 */
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { PERMISSION_DEFINITIONS } from "@funwind/db";
import { BUILTIN_GIDS, TEAM_ROLES } from "./mapping/legacy-roles.js";
import { AS_OF, config } from "./config.js";
import { closePools, newQuery, oldQuery } from "./db.js";
import { auditStored, confinedPath, safeExt } from "./lib/files.js";
import { Report } from "./lib/report.js";
import { EMOJI_NAMES } from "./transform/emoji-names.js";
import { MEMBER_GIDS } from "./transform/legacy-groups.js";
import { legacyAvatarKey } from "./transform/users.js";

interface Check {
  group: string;
  name: string;
  pass: boolean;
  detail: string;
}
const checks: Check[] = [];
let group = "";
const add = (name: string, pass: boolean, detail: string) =>
  checks.push({ group, name, pass, detail });
const num = async (sql: string, q: typeof oldQuery = oldQuery, params: unknown[] = []) =>
  Number((await q<{ n: number }>(sql, params))[0]?.n ?? 0);
const eq = (name: string, expected: number, actual: number, label = "") =>
  add(name, expected === actual, `${label}期望 ${expected} / 实际 ${actual}`);

const asOfUnix = Math.floor(new Date(`${AS_OF.replace(" ", "T")}+08:00`).getTime() / 1000);

// 对账只适用于「纯导入」的库：期望值来自旧库，叠加演示夹具（db:seed，id ≥ 90000）后数量必然不同
{
  const demo = await num("SELECT COUNT(*) n FROM users WHERE id >= 90000", newQuery);
  if (demo > 0) {
    console.error(
      `✘ 当前库含 ${demo} 个演示用户（db:seed 的夹具），迁移对账只适用于纯导入的库。\n` +
        `  请对未叠加演示数据的库运行（如 qysub_next），或先重建后只执行 pnpm migrate。`,
    );
    await closePools();
    process.exit(2);
  }
}

// ---------- 共享的独立推导（全部直接对旧库写 SQL / 独立代码，不复用迁移的转换函数） ----------

/** 回收站版块子树（名称含「回收站」的版块及其全部后代）——不迁移 */
const oldForums = await oldQuery<{ fid: number; parentid: number; name: string }>(
  "SELECT fid, parentid, name FROM nw_bbs_forum",
);
const recycled = new Set<number>(
  oldForums.filter((f) => String(f.name).includes("回收站")).map((f) => Number(f.fid)),
);
for (let grew = true; grew;) {
  grew = false;
  for (const f of oldForums) {
    if (!recycled.has(Number(f.fid)) && recycled.has(Number(f.parentid))) {
      recycled.add(Number(f.fid));
      grew = true;
    }
  }
}
const keepFids = oldForums.map((f) => Number(f.fid)).filter((f) => !recycled.has(f));
const keepFidSql = keepFids.join(",");

/** 垃圾空壳主题：无首帖正文且无回帖（别名 t 指向 nw_bbs_threads） */
const SHELL = `NOT EXISTS (SELECT 1 FROM nw_bbs_threads_content c WHERE c.tid = t.tid)
   AND NOT EXISTS (SELECT 1 FROM nw_bbs_posts p WHERE p.tid = t.tid)`;
/** 应迁移的主题：可见、版块仍在、有作者、非空壳 */
const EXP_THREAD = `t.disabled = 0 AND t.ifshield = 0 AND t.fid IN (${keepFidSql})
   AND t.created_userid > 0 AND NOT (${SHELL})`;
/** 应迁移的回帖（别名 p，所属主题别名 t 必须满足 EXP_THREAD） */
const EXP_POST = `p.disabled = 0 AND p.ifshield = 0 AND p.created_userid > 0`;

/** 只发过垃圾空壳主题的账号（不迁移） */
const spamUids = (
  await oldQuery<{ uid: number }>(`
    SELECT t.created_userid uid FROM nw_bbs_threads t
    LEFT JOIN nw_bbs_threads_content c ON c.tid = t.tid
    WHERE c.tid IS NULL AND NOT EXISTS (SELECT 1 FROM nw_bbs_posts p WHERE p.tid = t.tid)
      AND EXISTS (SELECT 1 FROM nw_user u WHERE u.uid = t.created_userid)
      AND NOT EXISTS (SELECT 1 FROM nw_bbs_posts p2 WHERE p2.created_userid = t.created_userid)
      AND NOT EXISTS (SELECT 1 FROM nw_bbs_threads t2 JOIN nw_bbs_threads_content c2 ON c2.tid = t2.tid
                      WHERE t2.created_userid = t.created_userid)
    GROUP BY t.created_userid`)
).map((r) => Number(r.uid));
const NOT_SPAM = spamUids.length ? `NOT IN (${spamUids.join(",")})` : "IS NOT NULL";

// ---------- 用户 ----------
group = "用户";
{
  const realUsers = (await num("SELECT COUNT(*) n FROM nw_user")) - spamUids.length;
  eq(
    "真实用户数（旧用户 − spam 账号）",
    realUsers,
    await num("SELECT COUNT(*) n FROM users WHERE state = 'active'", newQuery),
  );
  eq(
    "行数 user_profiles（真实用户 + 占位账号）",
    await num("SELECT COUNT(*) n FROM users", newQuery),
    await num("SELECT COUNT(*) n FROM user_profiles", newQuery),
  );
  const [u] = await newQuery<{ n: number; uk: number; ek: number; nopw: number; nodate: number }>(
    `SELECT COUNT(*) n, COUNT(DISTINCT username_key) uk, COUNT(email_key) ek,
            SUM(password_hash IS NOT NULL) nopw, SUM(created_at IS NULL) nodate FROM users`,
  );
  add("用户名归一化键唯一", Number(u!.uk) === Number(u!.n), `${u!.uk}/${u!.n}`);
  const dek = await num("SELECT COUNT(DISTINCT email_key) n FROM users", newQuery);
  add("邮箱归一化键唯一", dek === Number(u!.ek), `${dek}/${u!.ek}`);
  add("密码哈希一律为空（红线）", Number(u!.nopw) === 0, `非空 ${u!.nopw}`);
  add("注册时间无空值", Number(u!.nodate) === 0, `空 ${u!.nodate}`);

  // 平假名/片假名账号都在（旧站 EUC-JP 实测红线：さくら≠サクラ）
  eq(
    "假名用户名不碰撞",
    await num("SELECT COUNT(*) n FROM nw_user WHERE username IN ('さくら','サクラ')"),
    await num("SELECT COUNT(*) n FROM users WHERE username IN ('さくら','サクラ')", newQuery),
  );

  // spam 账号不迁：它们的 uid 不得以真实用户身份出现
  const spamLeak = spamUids.length
    ? await num(
        `SELECT COUNT(*) n FROM users WHERE state = 'active' AND id IN (${spamUids.join(",")})`,
        newQuery,
      )
    : 0;
  add("spam 账号未作为真实用户迁入", spamLeak === 0, `${spamUids.length} 个，泄入 ${spamLeak}`);

  // 头像：旧站磁盘上有主图的真实用户数 = 带 avatar_file_id 的用户数
  const olds = await oldQuery<{ uid: number }>(`SELECT uid FROM nw_user WHERE uid ${NOT_SPAM}`);
  const expAvatars = olds.filter((r) =>
    existsSync(join(config.attachmentDir, legacyAvatarKey(Number(r.uid)))),
  ).length;
  eq(
    "有头像的用户数（旧站磁盘上有主图）",
    expAvatars,
    await num("SELECT COUNT(*) n FROM user_profiles WHERE avatar_file_id IS NOT NULL", newQuery),
  );

  // 占位账号：引用诚实——内容作者都在 users；占位账号都有内容且不带身份信息、不持有资产
  const orphanAuthors = await num(
    `SELECT (SELECT COUNT(*) FROM threads t LEFT JOIN users u ON u.id = t.author_id WHERE u.id IS NULL)
          + (SELECT COUNT(*) FROM posts p LEFT JOIN users u ON u.id = p.author_id WHERE u.id IS NULL)
          + (SELECT COUNT(*) FROM attachments a LEFT JOIN users u ON u.id = a.uploader_id WHERE u.id IS NULL) AS n`,
    newQuery,
  );
  add("内容作者/上传者都指向存在的用户", orphanAuthors === 0, `悬空 ${orphanAuthors}`);
  const useless = await num(
    `SELECT COUNT(*) n FROM users u WHERE u.state = 'deleted'
       AND NOT EXISTS (SELECT 1 FROM threads t WHERE t.author_id = u.id)
       AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.author_id = u.id)
       AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.uploader_id = u.id)`,
    newQuery,
  );
  add("占位账号都有内容（无多余占位）", useless === 0, `多余 ${useless}`);
  const phBad = await num(
    `SELECT COUNT(*) n FROM users WHERE state = 'deleted'
       AND (email IS NOT NULL OR password_hash IS NOT NULL OR username <> CONCAT('已注销用户#', id))`,
    newQuery,
  );
  add("占位账号无邮箱/密码且命名规范", phBad === 0, `异常 ${phBad}`);
  const phAssets = await num(
    `SELECT (SELECT COUNT(*) FROM point_accounts a JOIN users u ON u.id = a.user_id WHERE u.state = 'deleted')
          + (SELECT COUNT(*) FROM user_roles r JOIN users u ON u.id = r.user_id WHERE u.state = 'deleted')
          + (SELECT COUNT(*) FROM user_badges b JOIN users u ON u.id = b.user_id WHERE u.state = 'deleted')
          + (SELECT COUNT(*) FROM follows f JOIN users u ON u.id = f.user_id WHERE u.state = 'deleted')
          + (SELECT COUNT(*) FROM reactions r JOIN users u ON u.id = r.user_id WHERE u.state = 'deleted')
          + (SELECT COUNT(*) FROM gate_unlocks g JOIN users u ON u.id = g.user_id WHERE u.state = 'deleted') AS n`,
    newQuery,
  );
  add("占位账号不持有积分/角色/徽章/关注/点赞/解锁", phAssets === 0, `持有 ${phAssets}`);
}

// ---------- 版块 ----------
group = "版块";
{
  eq(
    "行数 forums（旧版块 − 回收站子树）",
    keepFids.length,
    await num("SELECT COUNT(*) n FROM forums", newQuery),
  );
  const recycledLeak = recycled.size
    ? await num(`SELECT COUNT(*) n FROM forums WHERE id IN (${[...recycled].join(",")})`, newQuery)
    : 0;
  add(
    "回收站子树未迁入",
    recycledLeak === 0,
    `回收站版块 ${[...recycled].join("、")}，泄入 ${recycledLeak}`,
  );

  const bad = await newQuery<{ id: number }>(
    `SELECT f.id FROM forums f LEFT JOIN forums p ON p.id = f.parent_id
     WHERE (f.parent_id = 0 AND (f.path <> CONCAT('/', f.id, '/') OR f.depth <> 1))
        OR (f.parent_id > 0 AND (p.id IS NULL OR f.path <> CONCAT(p.path, f.id, '/') OR f.depth <> p.depth + 1))`,
  );
  add(
    "path / depth 与父链一致",
    bad.length === 0,
    bad.length ? `异常: ${bad.map((b) => b.id)}` : "全部一致",
  );
  const maxDepth = await num("SELECT MAX(depth) n FROM forums", newQuery);
  add("层级深度", maxDepth >= 1, `最大 ${maxDepth} 层`);

  // 板块图（M9.5 §3.4.3）：旧库 icon 非空且附件实存的版块 → 新库 icon_key 非空且可解析（ab/cd/<sha>.<ext>）
  {
    const [oldIcons, newIcons, badKeys] = await Promise.all([
      oldQuery<{ fid: number }>(
        `SELECT fid FROM nw_bbs_forum WHERE fid IN (${keepFidSql}) AND icon <> ''`,
      ),
      newQuery<{ id: number }>("SELECT id FROM forums WHERE icon_key IS NOT NULL"),
      newQuery<{ id: number }>(
        `SELECT id FROM forums WHERE icon_key IS NOT NULL
         AND icon_key NOT REGEXP '^[0-9a-f]{2}/[0-9a-f]{2}/[0-9a-f]{64}\\.(png|jpg|jpeg|gif|webp)$'`,
      ),
    ]);
    add(
      "板块图 icon_key 数与旧库 icon 非空数一致",
      newIcons.length === oldIcons.length,
      `旧 ${oldIcons.length} / 新 ${newIcons.length}`,
    );
    add(
      "板块图 storage key 格式可解析",
      badKeys.length === 0,
      badKeys.length ? `异常: ${badKeys.map((b) => b.id)}` : "全部合法",
    );
  }

  // 读策略：独立用 FIND_IN_SET 推导期望的 public/members/restricted 数量
  const memberAny = [...MEMBER_GIDS].map((g) => `FIND_IN_SET(${g}, allow_read)`).join(" OR ");
  const expPublic = await num(
    `SELECT COUNT(*) n FROM nw_bbs_forum WHERE fid IN (${keepFidSql}) AND allow_read <> '' AND FIND_IN_SET(2, allow_read)`,
  );
  const expMembers = await num(
    `SELECT COUNT(*) n FROM nw_bbs_forum WHERE fid IN (${keepFidSql}) AND allow_read <> '' AND NOT FIND_IN_SET(2, allow_read) AND (${memberAny})`,
  );
  const expRestricted = await num(
    `SELECT COUNT(*) n FROM nw_bbs_forum WHERE fid IN (${keepFidSql}) AND allow_read <> '' AND NOT FIND_IN_SET(2, allow_read) AND NOT (${memberAny})`,
  );
  for (const [policy, exp] of [
    ["public", expPublic],
    ["members", expMembers],
    ["restricted", expRestricted],
  ] as const) {
    eq(
      `read_policy=${policy}`,
      exp,
      await num("SELECT COUNT(*) n FROM forums WHERE read_policy = ?", newQuery, [policy]),
    );
  }

  const restrictedNoGrant = await newQuery<{ id: number }>(
    `SELECT f.id FROM forums f WHERE f.read_policy = 'restricted'
       AND NOT EXISTS (SELECT 1 FROM role_grants g WHERE g.permission_key = 'forum.read' AND g.scope_id = f.id)`,
  );
  add(
    "restricted 版块都有团队读授权",
    restrictedNoGrant.length === 0,
    restrictedNoGrant.length ? `缺: ${restrictedNoGrant.map((r) => r.id)}` : "全部具备",
  );
  const strayScope = await newQuery<{ scope_id: number }>(
    `SELECT DISTINCT g.scope_id FROM role_grants g LEFT JOIN forums f ON f.id = g.scope_id
     WHERE g.scope_id > 0 AND (f.id IS NULL OR (f.read_policy <> 'restricted' AND f.write_policy <> 'restricted'))`,
  );
  add(
    "版块作用域授权只落在 restricted 版块",
    strayScope.length === 0,
    strayScope.length ? `异常: ${strayScope.map((r) => r.scope_id)}` : "无越界",
  );

  eq(
    "is_listed=0 的版块数",
    await num(`SELECT COUNT(*) n FROM nw_bbs_forum WHERE isshow = 0 AND fid IN (${keepFidSql})`),
    await num("SELECT COUNT(*) n FROM forums WHERE is_listed = 0", newQuery),
  );
  eq(
    "forum_prefixes（仅被引用）",
    await num(
      "SELECT COUNT(DISTINCT t.id) n FROM nw_bbs_topic_type t JOIN nw_bbs_threads th ON th.topic_type = t.id",
    ),
    await num("SELECT COUNT(*) n FROM forum_prefixes", newQuery),
  );
}

// ---------- 用户限制 ----------
group = "用户限制";
{
  // 独立推导：生效的禁言用户 = 未过期的 typeid=1 封禁 ∪ 禁止发言组成员（主组/附加组且未过期），且用户存在
  const expMute = await num(
    `SELECT COUNT(*) n FROM (
       SELECT b.uid FROM nw_user_ban b JOIN nw_user u ON u.uid = b.uid
        WHERE b.typeid = 1 AND (b.end_time = 0 OR b.end_time > ?) AND b.uid ${NOT_SPAM}
       UNION
       SELECT uid FROM nw_user WHERE groupid = 6 AND uid ${NOT_SPAM}
       UNION
       SELECT bl.uid FROM nw_user_belong bl JOIN nw_user u ON u.uid = bl.uid
        WHERE bl.gid = 6 AND (bl.endtime = 0 OR bl.endtime > ?) AND bl.uid ${NOT_SPAM}
     ) x`,
    oldQuery,
    [asOfUnix, asOfUnix],
  );
  eq(
    "禁言用户数",
    expMute,
    await num(
      "SELECT COUNT(DISTINCT user_id) n FROM user_restrictions WHERE kind = 'mute'",
      newQuery,
    ),
  );
  for (const [typeid, kind] of [
    [2, "no_avatar"],
    [4, "no_signature"],
  ] as const) {
    eq(
      `${kind} 条数`,
      await num(
        `SELECT COUNT(*) n FROM nw_user_ban b JOIN nw_user u ON u.uid = b.uid
          WHERE b.typeid = ? AND (b.end_time = 0 OR b.end_time > ?) AND b.uid ${NOT_SPAM}`,
        oldQuery,
        [typeid, asOfUnix],
      ),
      await num("SELECT COUNT(*) n FROM user_restrictions WHERE kind = ?", newQuery, [kind]),
    );
  }
  const none = await num(
    "SELECT COUNT(*) n FROM user_restrictions WHERE ends_at IS NOT NULL AND ends_at <= ?",
    newQuery,
    [AS_OF],
  );
  add("没有已过期的限制", none === 0, `过期 ${none}`);
  const orphan = await num(
    "SELECT COUNT(*) n FROM user_restrictions r LEFT JOIN users u ON u.id = r.user_id WHERE u.id IS NULL",
    newQuery,
  );
  add("限制不指向不存在的用户", orphan === 0, `孤儿 ${orphan}`);
}

// ---------- 权限 ----------
group = "权限";
{
  const dirtyRole = await num(
    `SELECT COUNT(*) n FROM (SELECT role_key FROM role_grants UNION SELECT role_key FROM user_roles) x
     WHERE role_key NOT IN (SELECT \`key\` FROM roles)`,
    newQuery,
  );
  const dirtyPerm = await num(
    "SELECT COUNT(*) n FROM role_grants WHERE permission_key NOT IN (SELECT `key` FROM permissions)",
    newQuery,
  );
  add("无词汇表外的角色键（v1 的 a/x 脏键）", dirtyRole === 0, `脏角色键 ${dirtyRole}`);
  add("无词汇表外的权限点（v1 的 p1/p2/y 脏键）", dirtyPerm === 0, `脏权限点 ${dirtyPerm}`);

  const dupGrant = await num(
    `SELECT COUNT(*) n FROM (SELECT 1 FROM role_grants GROUP BY role_key, permission_key, scope_id HAVING COUNT(*) > 1) x`,
    newQuery,
  );
  const dupRole = await num(
    `SELECT COUNT(*) n FROM (SELECT 1 FROM user_roles GROUP BY user_id, role_key, scope_id HAVING COUNT(*) > 1) x`,
    newQuery,
  );
  add(
    "授权/角色绑定无重复行（v1 重复 5 倍）",
    dupGrant === 0 && dupRole === 0,
    `授权重复 ${dupGrant} / 绑定重复 ${dupRole}`,
  );

  const orphanRole = await num(
    "SELECT COUNT(*) n FROM user_roles r LEFT JOIN users u ON u.id = r.user_id WHERE u.id IS NULL",
    newQuery,
  );
  add("角色绑定不指向不存在的用户", orphanRole === 0, `孤儿 ${orphanRole}`);

  // 每个自定义/管理员角色的持有人数 = 旧库对应 gid 的未过期成员（主组 ∪ 附加组）去重
  const gidRoles = [
    { key: "admin", gids: [...BUILTIN_GIDS.admin] },
    ...TEAM_ROLES.map((t) => ({ key: t.key, gids: [t.gid] })),
  ];
  for (const role of gidRoles) {
    const gids = role.gids.join(",");
    const expected = await num(
      `SELECT COUNT(*) n FROM (
         SELECT u.uid FROM nw_user u WHERE u.groupid IN (${gids})
         UNION
         SELECT b.uid FROM nw_user_belong b JOIN nw_user u ON u.uid = b.uid
          WHERE b.gid IN (${gids}) AND (b.endtime = 0 OR b.endtime > ${asOfUnix})
       ) x`,
    );
    eq(
      `角色持有人 ${role.key}（旧 gid ${gids}）`,
      expected,
      await num("SELECT COUNT(DISTINCT user_id) n FROM user_roles WHERE role_key = ?", newQuery, [
        role.key,
      ]),
    );
  }

  // 提权护栏：非 admin 角色不得拥有全局的管理/版主类权限（v2 词汇表映射错误曾导致全体会员获得版主权）
  const escalated = await newQuery<{ role_key: string; permission_key: string }>(
    `SELECT role_key, permission_key FROM role_grants
     WHERE scope_id = 0 AND role_key <> 'admin'
       AND (permission_key IN ('forum.moderate', 'site.admin', 'user.viewIp', 'thread.replyLocked')
            OR permission_key LIKE 'admin.%')`,
  );
  add(
    "提权护栏：非 admin 无全局管理/版主权",
    escalated.length === 0,
    escalated.length
      ? escalated.map((e) => `${e.role_key}:${e.permission_key}`).join("、")
      : "无越权授权",
  );

  const admin = await num(
    "SELECT COUNT(*) n FROM role_grants WHERE role_key = 'admin' AND permission_key = 'site.admin' AND scope_id = 0",
    newQuery,
  );
  add("admin 拥有后台入口", admin === 1, `site.admin 授权 ${admin} 条`);
  const memberWrite = await num(
    "SELECT COUNT(*) n FROM role_grants WHERE role_key = 'member' AND permission_key = 'forum.write' AND scope_id = 0",
    newQuery,
  );
  add("会员拥有全局发帖权", memberWrite === 1, `forum.write 授权 ${memberWrite} 条`);
  const vocab = await num("SELECT COUNT(*) n FROM permissions", newQuery);
  add(
    "权限词汇表就位",
    vocab >= PERMISSION_DEFINITIONS.length,
    `${vocab}/${PERMISSION_DEFINITIONS.length}`,
  );
}

// ---------- 站点设置 ----------
group = "站点设置";
{
  const rows = await newQuery<{ value: unknown }>(
    "SELECT value FROM site_settings WHERE `key` = 'points.name'",
  );
  const v =
    typeof rows[0]?.value === "string" ? JSON.parse(rows[0].value as string) : rows[0]?.value;
  add(
    "积分显示名",
    (v as { name?: string } | undefined)?.name === "青翼币",
    JSON.stringify(v ?? null),
  );
}

// ---------- 内容（统一 post 模型） ----------
group = "内容";
{
  const expThreads = await num(`SELECT COUNT(*) n FROM nw_bbs_threads t WHERE ${EXP_THREAD}`);
  eq(
    "行数 threads（只迁可见主题，独立 SQL）",
    expThreads,
    await num("SELECT COUNT(*) n FROM threads", newQuery),
  );
  eq(
    "回帖数（可见回帖 ∩ 迁移的主题，独立 SQL）",
    await num(
      `SELECT COUNT(*) n FROM nw_bbs_posts p JOIN nw_bbs_threads t ON t.tid = p.tid
        WHERE ${EXP_THREAD} AND ${EXP_POST}`,
    ),
    await num("SELECT COUNT(*) n FROM posts WHERE floor > 1", newQuery),
  );
  eq(
    "首帖数 = 主题数",
    await num("SELECT COUNT(*) n FROM threads", newQuery),
    await num("SELECT COUNT(*) n FROM posts WHERE floor = 1", newQuery),
  );
  const notVisible = await num(
    "SELECT (SELECT COUNT(*) FROM threads WHERE state <> 'visible') + (SELECT COUNT(*) FROM posts WHERE state <> 'visible') AS n",
    newQuery,
  );
  add("迁入的内容全部是 visible", notVisible === 0, `非 visible ${notVisible}`);

  // 回帖保留旧 pid 且仍在原主题
  const oldPid = new Map(
    (await oldQuery<{ pid: number; tid: number }>("SELECT pid, tid FROM nw_bbs_posts")).map((r) => [
      Number(r.pid),
      Number(r.tid),
    ]),
  );
  const replies = await newQuery<{ id: number; thread_id: number }>(
    "SELECT id, thread_id FROM posts WHERE floor > 1",
  );
  const movedReplies = replies.filter((r) => oldPid.get(Number(r.id)) !== Number(r.thread_id));
  add("回帖保留旧 pid 且仍属原主题", movedReplies.length === 0, `异常 ${movedReplies.length}`);

  // 首帖 id：全部大于旧站最大 pid（不复用任何旧 pid），且随 tid 升序自增
  const maxOld = await num("SELECT MAX(pid) n FROM nw_bbs_posts");
  const minFirst = await num("SELECT MIN(id) n FROM posts WHERE floor = 1", newQuery);
  add("首帖 id 全部大于旧站最大 pid", minFirst > maxOld, `最小首帖 ${minFirst} > 旧最大 ${maxOld}`);
  const unordered = await num(
    "SELECT COUNT(*) n FROM threads a JOIN threads b ON a.id < b.id AND a.first_post_id > b.first_post_id",
    newQuery,
  );
  add("首帖 id 随 tid 升序", unordered === 0, `逆序对 ${unordered}`);
  const firstGap = await num(
    "SELECT MAX(first_post_id) - MIN(first_post_id) + 1 - COUNT(*) n FROM threads",
    newQuery,
  );
  add("首帖 id 连续自增（无空洞）", firstGap === 0, `空洞 ${firstGap}`);

  const gaps = await num(
    "SELECT COUNT(*) n FROM (SELECT thread_id FROM posts GROUP BY thread_id HAVING COUNT(*) <> MAX(floor)) x",
    newQuery,
  );
  add("楼层连续（无断层、无重复）", gaps === 0, `断层主题 ${gaps}`);
  const badFirst = await num(
    `SELECT COUNT(*) n FROM threads t LEFT JOIN posts p ON p.id = t.first_post_id AND p.floor = 1 AND p.thread_id = t.id
      WHERE p.id IS NULL`,
    newQuery,
  );
  add("每个主题都有 floor=1 的首帖", badFirst === 0, `缺首帖 ${badFirst}`);

  // 置顶 / 精华（独立 SQL）
  eq(
    "置顶主题数（pin_level>0）",
    await num(`SELECT COUNT(*) n FROM nw_bbs_threads t WHERE ${EXP_THREAD} AND t.topped > 0`),
    await num("SELECT COUNT(*) n FROM threads WHERE pin_level > 0", newQuery),
  );
  eq(
    "精华主题数（is_featured）",
    await num(`SELECT COUNT(*) n FROM nw_bbs_threads t WHERE ${EXP_THREAD} AND t.digest > 0`),
    await num("SELECT COUNT(*) n FROM threads WHERE is_featured = 1", newQuery),
  );

  const dangling = await num(
    `SELECT (SELECT COUNT(*) FROM posts p LEFT JOIN threads t ON t.id = p.thread_id WHERE t.id IS NULL)
          + (SELECT COUNT(*) FROM threads t LEFT JOIN forums f ON f.id = t.forum_id WHERE f.id IS NULL)
          + (SELECT COUNT(*) FROM attachments a LEFT JOIN posts p ON p.id = a.post_id WHERE p.id IS NULL)
          + (SELECT COUNT(*) FROM posts p JOIN posts r ON r.id = p.reply_to_post_id WHERE r.thread_id <> p.thread_id)
          + (SELECT COUNT(*) FROM posts p LEFT JOIN posts r ON r.id = p.reply_to_post_id
              WHERE p.reply_to_post_id IS NOT NULL AND r.id IS NULL) AS n`,
    newQuery,
  );
  add(
    "引用完整（帖→主题、主题→版块、附件→帖、回复指针同主题）",
    dangling === 0,
    `悬空 ${dangling}`,
  );

  // 附件：所属主题被迁移、且文件在旧站磁盘上存在（独立用 existsSync 推导）
  const oldAtts = await oldQuery<{ tid: number; path: string }>(
    `SELECT a.tid, a.path FROM nw_attachs_thread a JOIN nw_bbs_threads t ON t.tid = a.tid WHERE ${EXP_THREAD}`,
  );
  const expAtts = oldAtts.filter((a) => existsSync(join(config.attachmentDir, a.path))).length;
  eq(
    "附件数（主题已迁移且源文件存在）",
    expAtts,
    await num("SELECT COUNT(*) n FROM attachments", newQuery),
  );

  // 附件归属门控（docs/ATTACHMENT-GATES.md §7）：从导入结果反查「引用位置」独立推导期望，不信转换器自己的统计。
  // 引用判定用存储键在 body_md / hidden_md 里的出现；这三类结论对任何数据都必须成立。
  const anomalies = await num(
    `SELECT (SELECT COUNT(*) FROM attachments a LEFT JOIN post_gates g ON g.id = a.gate_id
              WHERE a.gate_id IS NOT NULL AND g.id IS NULL)
          + (SELECT COUNT(*) FROM attachments a JOIN post_gates g ON g.id = a.gate_id
              WHERE g.post_id <> a.post_id)
          + (SELECT COUNT(*) FROM attachments a JOIN posts p ON p.id = a.post_id
              WHERE a.gate_id IS NOT NULL AND p.has_gate = 0) AS n`,
    newQuery,
  );
  add("附件门控归属无悬空/跨帖/挂在非门控帖", anomalies === 0, `异常 ${anomalies}`);
  const gatedAtts = await newQuery<{
    id: number;
    gate_id: number | null;
    in_pub: number;
    hid_gates: string | null;
  }>(
    `SELECT a.id, a.gate_id,
            (p.body_md LIKE CONCAT('%', f.storage_key, '%')) AS in_pub,
            (SELECT GROUP_CONCAT(g.id) FROM post_gates g
              WHERE g.post_id = a.post_id AND g.hidden_md LIKE CONCAT('%', f.storage_key, '%')) AS hid_gates
       FROM attachments a
       JOIN posts p ON p.id = a.post_id AND p.has_gate = 1
       JOIN files f ON f.id = a.file_id`,
  );
  const unreferencedPublic = gatedAtts.filter(
    (a) => !Number(a.in_pub) && a.hid_gates === null && a.gate_id === null,
  );
  add(
    "门控帖里未被任何正文引用的附件一律归属门控（不得公开）",
    unreferencedPublic.length === 0,
    `公开的 ${unreferencedPublic.length}`,
  );
  const hiddenOnlyWrong = gatedAtts.filter(
    (a) =>
      !Number(a.in_pub) &&
      a.hid_gates !== null &&
      (a.gate_id === null || !a.hid_gates.split(",").includes(String(a.gate_id))),
  );
  add(
    "只在门控内引用的附件归属引用它的门控",
    hiddenOnlyWrong.length === 0,
    `错位 ${hiddenOnlyWrong.length}`,
  );
  const publicRefWrong = gatedAtts.filter((a) => Number(a.in_pub) && a.gate_id !== null);
  add(
    "在公开正文引用的附件保持公开",
    publicRefWrong.length === 0,
    `被误锁 ${publicRefWrong.length}`,
  );
}

// ---------- 门控（安全核心） ----------
group = "门控";
{
  // 零泄露：任何一个门控的隐藏全文都不得出现在同一帖的公开正文里
  const leaked = await newQuery<{ post_id: number; id: number }>(
    `SELECT g.post_id, g.id FROM post_gates g JOIN posts p ON p.id = g.post_id
      WHERE CHAR_LENGTH(g.hidden_md) >= 12 AND LOCATE(g.hidden_md, p.body_md) > 0`,
  );
  add(
    "隐藏内容零泄露（hidden_md 全文不出现在 body_md）",
    leaked.length === 0,
    leaked.length ? `泄露: ${leaked.map((l) => l.id)}` : "0 处",
  );

  const raw = await num(
    `SELECT COUNT(*) n FROM posts WHERE LOWER(body_md) REGEXP '\\\\[/?(sell|hide)[=\\\\]]|\\\\[/?post\\\\]'`,
    newQuery,
  );
  add("公开正文中没有残留的旧门控标签", raw === 0, `残留 ${raw} 帖`);

  const flagBad = await num(
    `SELECT COUNT(*) n FROM posts p WHERE p.has_gate <> EXISTS (SELECT 1 FROM post_gates g WHERE g.post_id = p.id)`,
    newQuery,
  );
  add("has_gate 与 post_gates 一致", flagBad === 0, `不一致 ${flagBad}`);

  // 占位 ⇄ 门控一一对应：正文里的 :::gate{key="…"} 集合 = 该帖 post_gates 的 gate_key 集合
  const withGate = await newQuery<{ id: number; body_md: string }>(
    "SELECT id, body_md FROM posts WHERE has_gate = 1",
  );
  const keysOf = new Map<number, Set<string>>();
  for (const g of await newQuery<{ post_id: number; gate_key: string }>(
    "SELECT post_id, gate_key FROM post_gates",
  )) {
    const set = keysOf.get(Number(g.post_id)) ?? new Set<string>();
    set.add(g.gate_key);
    keysOf.set(Number(g.post_id), set);
  }
  let badPlaceholders = 0;
  const examples: number[] = [];
  for (const p of withGate) {
    const inBody = new Set(
      [...p.body_md.matchAll(/:::gate\{key="([A-Za-z0-9_-]{1,16})"\}/g)].map((m) => m[1]!),
    );
    const inDb = keysOf.get(Number(p.id)) ?? new Set<string>();
    const same = inBody.size === inDb.size && [...inBody].every((k) => inDb.has(k));
    if (!same) {
      badPlaceholders++;
      if (examples.length < 5) examples.push(Number(p.id));
    }
  }
  add(
    "正文占位与 post_gates 一一对应（按 gate_key）",
    badPlaceholders === 0,
    badPlaceholders ? `不一致 ${badPlaceholders} 帖: ${examples}` : `${withGate.length} 帖全部一致`,
  );

  // gate id：1..n 连续，且按 (post_id, 帖内序号) 升序
  const gateIds = await newQuery<{ lo: number; hi: number; n: number }>(
    "SELECT MIN(id) lo, MAX(id) hi, COUNT(*) n FROM post_gates",
  );
  const gi = gateIds[0]!;
  add(
    "门控 id 为 1..n 连续自增",
    Number(gi.n) === 0 || (Number(gi.lo) === 1 && Number(gi.hi) === Number(gi.n)),
    `${gi.lo}..${gi.hi}，共 ${gi.n}`,
  );
  const gateUnordered = await num(
    "SELECT COUNT(*) n FROM post_gates a JOIN post_gates b ON a.id < b.id AND a.post_id > b.post_id",
    newQuery,
  );
  add("门控 id 随 post_id 升序", gateUnordered === 0, `逆序对 ${gateUnordered}`);
  const badKey = await num(
    "SELECT COUNT(*) n FROM post_gates WHERE gate_key NOT REGEXP '^g[0-9]+$'",
    newQuery,
  );
  add("迁入门控的 gate_key 形如 g{序号}", badKey === 0, `异常 ${badKey}`);

  const badUnlock = await num(
    `SELECT COUNT(*) n FROM gate_unlocks u
      LEFT JOIN post_gates g ON g.id = u.gate_id LEFT JOIN users x ON x.id = u.user_id
      WHERE g.id IS NULL OR x.id IS NULL OR x.state <> 'active'`,
    newQuery,
  );
  add("解锁记录引用完整（解锁者是真实用户）", badUnlock === 0, `悬空 ${badUnlock}`);
  const cnt = await num(
    `SELECT COUNT(*) n FROM post_gates g WHERE g.unlock_count <> (SELECT COUNT(*) FROM gate_unlocks u WHERE u.gate_id = g.id)`,
    newQuery,
  );
  add("unlock_count 与明细一致", cnt === 0, `不一致 ${cnt}`);
  const priced = await num(
    `SELECT COUNT(*) n FROM post_gates WHERE JSON_EXTRACT(conditions, '$[0].type') = 'points'
       AND JSON_EXTRACT(conditions, '$[0].price') >= 9999`,
    newQuery,
  );
  add("没有 ≥ 9999 的占位价格（已重置为免费）", priced === 0, `残留 ${priced}`);
  const gateTypes = await newQuery<{ t: string }>(
    "SELECT DISTINCT JSON_UNQUOTE(JSON_EXTRACT(conditions, '$[0].type')) t FROM post_gates",
  );
  const bad = gateTypes.map((r) => r.t).filter((t) => !["points", "reply"].includes(t));
  add("条件类型均已注册", bad.length === 0, bad.length ? `未知: ${bad}` : "points / reply");
}

// ---------- 文本保留与表情 ----------
group = "文本保留";
{
  const cjk = (x: string) =>
    (x.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) ?? []).length;
  const stripUbb = (x: string) =>
    x.replace(/\[\/?[a-zA-Z]+(?:=[^\]\n]*)?\]/g, "").replace(/\[s:\d+\]/gi, "");
  let src = 0;
  for (const r of await oldQuery<{ c: string }>(
    `SELECT c.content AS c FROM nw_bbs_threads_content c JOIN nw_bbs_threads t ON t.tid = c.tid WHERE ${EXP_THREAD}`,
  ))
    src += cjk(stripUbb(r.c ?? ""));
  for (const r of await oldQuery<{ c: string }>(
    `SELECT p.content AS c FROM nw_bbs_posts p JOIN nw_bbs_threads t ON t.tid = p.tid
      WHERE ${EXP_THREAD} AND ${EXP_POST}`,
  )) {
    src += cjk(stripUbb(r.c ?? ""));
  }
  let out = 0;
  for (const r of await newQuery<{ c: string }>("SELECT body_md AS c FROM posts"))
    out += cjk(r.c ?? "");
  for (const r of await newQuery<{ c: string }>("SELECT hidden_md AS c FROM post_gates"))
    out += cjk(r.c ?? "");
  const ratio = out / src;
  add(
    "汉字/假名保留率（公开正文 + 隐藏内容）",
    ratio >= 0.98 && ratio <= 1.05,
    `源 ${src} → 出 ${out}（${(ratio * 100).toFixed(2)}%）`,
  );

  const legacyCodes = await num(
    `SELECT COUNT(*) n FROM posts WHERE body_md REGEXP '\\\\[s:1[2-6][0-9]\\\\]'`,
    newQuery,
  );
  add("映射内的表情码已全部展开", legacyCodes === 0, `残留 ${legacyCodes} 帖`);

  const refs = new Set<number>();
  for (const r of await newQuery<{ c: string }>(
    "SELECT body_md AS c FROM posts WHERE body_md LIKE '%/emoji/%'",
  )) {
    for (const m of (r.c ?? "").matchAll(/\/emoji\/(\d+)\.gif/g)) refs.add(Number(m[1]));
  }
  const missingEmoji = [...refs].filter((id) => !existsSync(join(config.emojiOutDir, `${id}.gif`)));
  add(
    "引用的表情静态资源都存在",
    missingEmoji.length === 0,
    `引用 ${refs.size} 种，缺失 ${missingEmoji.length}`,
  );

  // 内联样式降级：不得残留旧站颜色/字号等标签
  const styled = await num(
    `SELECT COUNT(*) n FROM posts WHERE LOWER(body_md) REGEXP '\\\\[/?(color|size|backcolor|align|font)[=\\\\]]'`,
    newQuery,
  );
  add("内联样式标签已降级（正文无残留）", styled === 0, `残留 ${styled} 帖`);
}

// ---------- 表情（M10.9 元数据入表） ----------
group = "表情";
{
  // 期望值独立推导：旧库 emotion 全表；在用分类 = 有成员的分类（Step 1 核实：恰好 2 个）
  const oldEmojis = await oldQuery<{ id: number; categoryName: string | null }>(
    `SELECT e.emotion_id AS id, c.category_name AS categoryName
       FROM nw_common_emotion e
       LEFT JOIN nw_common_emotion_category c ON e.category_id = c.category_id
      ORDER BY e.emotion_id`,
  );
  const ids = oldEmojis.map((r) => Number(r.id)).filter(Number.isInteger);
  const idList = ids.join(",");
  eq(
    "旧表情全部入表（id 120–169 原样保留）",
    ids.length,
    await num(`SELECT COUNT(*) n FROM emojis WHERE id IN (${idList})`, newQuery),
  );
  eq(
    "入表旧表情 storage_key 全空（内容是 public 静态资源）",
    ids.length,
    await num(
      `SELECT COUNT(*) n FROM emojis WHERE id IN (${idList}) AND storage_key IS NULL`,
      newQuery,
    ),
  );
  const gotGroups = (
    await newQuery<{ name: string }>(
      `SELECT DISTINCT g.name AS name FROM emoji_groups g JOIN emojis e ON e.group_id = g.id
        WHERE e.id IN (${idList}) ORDER BY g.name`,
    )
  )
    .map((r) => r.name)
    .sort();
  // 站长 2026-10-29 拍板：旧分类「茉莉 01 / 茉莉 02」在新系统合并为单组「茉莉」——对账随之改为单组断言
  add(
    "旧 50 枚全属合并后的单组「茉莉」（旧 2 分类已按站长决策合并）",
    JSON.stringify(gotGroups) === JSON.stringify(["茉莉"]),
    `实际 [${gotGroups.join("、")}]`,
  );
  const expNames = ids.map((id) => EMOJI_NAMES[id]).filter((n): n is string => Boolean(n));
  eq(
    "旧 50 枚的名称 = 读图拍板名（重导后亦为终态）",
    expNames.length,
    await num(
      `SELECT COUNT(*) n FROM emojis WHERE id IN (${idList}) AND name IN (${expNames
        .map((n) => `'${n.replace(/'/g, "''")}'`)
        .join(",")})`,
      newQuery,
    ),
  );
}

// ---------- 文件（内容寻址） ----------
group = "文件";
{
  const rows = await newQuery<{
    id: number;
    sha256: string;
    storage_key: string;
    mime: string;
  }>("SELECT id, sha256, storage_key, mime FROM files ORDER BY id");
  add("文件表非空", rows.length > 0, `${rows.length} 个文件`);

  // id 按 sha256 升序分配 → 重跑一致
  const sorted = [...rows].sort((a, b) => (a.sha256 < b.sha256 ? -1 : 1));
  const idsByHash = sorted.every((r, i) => Number(r.id) === i + 1);
  add("files.id 为 1..n 且按 sha256 升序", idsByHash, `${rows.length} 行`);

  // 存储键只取决于内容；扩展名限白名单（防止 .html/.svg 等可脚本化类型进入公开路径）
  const badKey = rows.filter((r) => {
    const ext = extname(r.storage_key).slice(1);
    return (
      r.storage_key !== `${r.sha256.slice(0, 2)}/${r.sha256.slice(2, 4)}/${r.sha256}.${ext}` ||
      safeExt(r.storage_key) !== ext
    );
  });
  add("存储键 = 哈希派生且扩展名在白名单内", badKey.length === 0, `异常 ${badKey.length}`);
  const badMime = rows.filter(
    (r) => safeExt(r.storage_key) === "bin" && r.mime !== "application/octet-stream",
  );
  add("白名单外的文件 mime 为 octet-stream", badMime.length === 0, `异常 ${badMime.length}`);

  // 存储里的文件逐个重算 SHA-256
  const bad = auditStored(
    rows.map((r) => ({ sha256: r.sha256, storageKey: r.storage_key })),
    config.storageDir,
  );
  add(
    "存储内文件均存在且 SHA-256 与登记一致",
    bad.length === 0,
    bad.length ? `异常 ${bad.length}: ${bad.slice(0, 3)}` : `${rows.length} 个已重算`,
  );

  // 引用闭合：被引用的文件都已登记；已登记的文件都被引用（无孤儿文件）
  const idByKey = new Map(rows.map((r) => [r.storage_key, Number(r.id)]));
  const used = new Set<number>();
  const unregistered = new Set<string>();
  for (const col of ["posts.body_md", "post_gates.hidden_md"]) {
    const [table, field] = col.split(".");
    for (const r of await newQuery<{ c: string }>(
      `SELECT ${field} AS c FROM ${table} WHERE ${field} LIKE '%/files/%'`,
    )) {
      // 只认站内相对地址：前一个字符不能是主机名/路径字符（排除 https://x.com/files/… 这类外链）
      for (const m of (r.c ?? "").matchAll(/(?<![\w.:/-])\/files\/([A-Za-z0-9/._-]+)/g)) {
        const key = m[1]!.replace(/[.)]+$/, "");
        const id = idByKey.get(key);
        if (id === undefined) unregistered.add(key);
        else used.add(id);
      }
    }
  }
  add("正文引用的 /files/ 地址都已登记", unregistered.size === 0, `未登记 ${unregistered.size}`);
  for (const sql of [
    "SELECT file_id AS id FROM attachments",
    "SELECT avatar_file_id AS id FROM user_profiles WHERE avatar_file_id IS NOT NULL",
    "SELECT icon_file_id AS id FROM badges WHERE icon_file_id IS NOT NULL",
    // 板块图（M9.5）：icon_key 是存储键而非 file_id——join files 换算成 id 计入引用
    "SELECT f.id AS id FROM forums fo JOIN files f ON f.storage_key = fo.icon_key WHERE fo.icon_key IS NOT NULL",
  ]) {
    for (const r of await newQuery<{ id: number }>(sql)) used.add(Number(r.id));
  }
  const orphanFiles = rows.filter((r) => !used.has(Number(r.id)));
  add("没有孤儿文件（登记的文件都被引用）", orphanFiles.length === 0, `孤儿 ${orphanFiles.length}`);
  // 附件引用收敛（M9.5 站长反馈）：download 行的文件不得同时被其帖子的正文（公开或门控隐藏）引用——
  // 否则图片既在正文渲染又重复出现在帖末下载列表（迁移直映射的存量缺口，files 步骤已收敛）
  {
    const leaked = await newQuery<{ id: number }>(
      `SELECT a.id FROM attachments a
       JOIN files f ON f.id = a.file_id
       JOIN posts p ON p.id = a.post_id
       WHERE a.kind = 'download' AND p.body_md LIKE CONCAT('%', f.storage_key, '%')`,
    );
    add(
      "download 附件不被公开正文引用（引用即转 inline）",
      leaked.length === 0,
      leaked.length ? `残留: ${leaked.map((l) => l.id).slice(0, 8)}` : "全部收敛",
    );
    const leakedGate = await newQuery<{ id: number }>(
      `SELECT a.id FROM attachments a
       JOIN files f ON f.id = a.file_id
       JOIN post_gates g ON g.id = a.gate_id
       WHERE a.kind = 'download' AND g.hidden_md LIKE CONCAT('%', f.storage_key, '%')`,
    );
    add(
      "download 附件不被其门控隐藏正文引用",
      leakedGate.length === 0,
      leakedGate.length ? `残留: ${leakedGate.map((l) => l.id).slice(0, 8)}` : "全部收敛",
    );
  }
  const danglingFile = await num(
    `SELECT (SELECT COUNT(*) FROM attachments a LEFT JOIN files f ON f.id = a.file_id WHERE f.id IS NULL)
          + (SELECT COUNT(*) FROM user_profiles p LEFT JOIN files f ON f.id = p.avatar_file_id
              WHERE p.avatar_file_id IS NOT NULL AND f.id IS NULL)
          + (SELECT COUNT(*) FROM badges b LEFT JOIN files f ON f.id = b.icon_file_id
              WHERE b.icon_file_id IS NOT NULL AND f.id IS NULL) AS n`,
    newQuery,
  );
  add("附件/头像/徽章图的 file_id 都存在", danglingFile === 0, `悬空 ${danglingFile}`);

  // 旧站上传路径只允许残留在「源文件本来就不存在」的图片上（保留原地址，页面上与旧站一样打不开）；
  // 源文件存在却没被改写成 /files/ 地址 = 转换漏网
  let missed = 0;
  let unresolvedRefs = 0;
  for (const r of await newQuery<{ c: string }>(
    "SELECT body_md AS c FROM posts WHERE body_md LIKE '%p_w_upload%' OR body_md LIKE '%/attachment/%'",
  )) {
    for (const m of (r.c ?? "").matchAll(/(?:p_w_upload|attachment)\/([^\s)"'\]]+)/g)) {
      unresolvedRefs++;
      const rel = decodeURIComponent(m[1]!.split(/[?#]/)[0]!);
      const abs = confinedPath(config.attachmentDir, rel);
      if (abs && existsSync(abs)) missed++;
    }
  }
  add(
    "旧站上传路径只残留在源文件不存在的图片上",
    missed === 0,
    `残留引用 ${unresolvedRefs} 处，其中源文件存在却未改写 ${missed}`,
  );
  const tagLeft = await num(
    "SELECT COUNT(*) n FROM posts WHERE body_md LIKE '%[p_w_upload=%' OR body_md LIKE '%[attachment=%'",
    newQuery,
  );
  add("附件标签已全部转换（无 [attachment=N] 字面量）", tagLeft === 0, `残留 ${tagLeft} 帖`);
}

// ---------- 积分与徽章 ----------
group = "积分";
{
  const sums = await newQuery<{ ledger: number; accounts: number }>(
    `SELECT (SELECT COALESCE(SUM(delta), 0) FROM point_ledger) ledger,
            (SELECT COALESCE(SUM(balance), 0) FROM point_accounts) accounts`,
  );
  eq("台账之和 = 账户余额之和", Number(sums[0]!.accounts), Number(sums[0]!.ledger));
  const mismatch = await num(
    `SELECT COUNT(*) n FROM point_accounts a
      WHERE a.balance <> (SELECT COALESCE(SUM(delta), 0) FROM point_ledger l WHERE l.user_id = a.user_id)`,
    newQuery,
  );
  add("每个账户余额 = 其台账之和", mismatch === 0, `不一致 ${mismatch}`);

  // 独立推导：旧 credit1（非负，仅真实用户）+ 银行存款本金（仅真实用户）
  const expected = await num(
    `SELECT (SELECT COALESCE(SUM(GREATEST(d.credit1, 0)), 0) FROM nw_user_data d JOIN nw_user u ON u.uid = d.uid WHERE u.uid ${NOT_SPAM})
          + (SELECT COALESCE(SUM(GREATEST(b.deposit, 0) + GREATEST(b.ddeposit, 0)), 0) FROM nw_app_bank b JOIN nw_user u ON u.uid = b.uid WHERE u.uid ${NOT_SPAM}) AS n`,
  );
  eq("期初余额总额（旧 credit1 + 银行本金，独立 SQL）", expected, Number(sums[0]!.accounts));
  const neg = await num("SELECT COUNT(*) n FROM point_accounts WHERE balance < 0", newQuery);
  add("没有负余额", neg === 0, `负余额 ${neg}`);
  const notOpening = await num(
    "SELECT COUNT(*) n FROM point_ledger WHERE channel <> 'opening'",
    newQuery,
  );
  add("台账只有期初分录（不迁旧流水）", notOpening === 0, `其他渠道 ${notOpening}`);

  // 签到：每个真实用户只保留最近一段连续签到——这里用另一种写法独立推导
  const days = await oldQuery<{ uid: number; d: string }>(
    `SELECT l.created_userid uid, DATE(DATE_ADD('1970-01-01', INTERVAL l.created_time + 28800 SECOND)) d
       FROM nw_credit_log l JOIN nw_user u ON u.uid = l.created_userid
      WHERE l.logtype = 'punch' AND u.uid ${NOT_SPAM}
      GROUP BY l.created_userid, d ORDER BY l.created_userid, d`,
  );
  const dayNo = (d: unknown) =>
    Math.round(Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`) / 86_400_000);
  const expectedChecks = new Set<string>();
  let run: { uid: number; d: string; no: number }[] = [];
  const flush = () => {
    for (const x of run) expectedChecks.add(`${x.uid}:${x.d}`);
    run = [];
  };
  for (const r of days) {
    const cur = { uid: Number(r.uid), d: String(r.d).slice(0, 10), no: dayNo(r.d) };
    const last = run[run.length - 1];
    if (last && (last.uid !== cur.uid || cur.no - last.no !== 1)) {
      // 用户换人：上一段就是该用户最近一段，保留；同一用户断档：上一段是更早历史，丢弃
      if (last.uid !== cur.uid) flush();
      else run = [];
    }
    run.push(cur);
  }
  flush();
  const actualChecks = new Set(
    (
      await newQuery<{ uid: number; d: string }>(
        "SELECT user_id uid, DATE_FORMAT(checkin_date, '%Y-%m-%d') d FROM checkins",
      )
    ).map((r) => `${r.uid}:${r.d}`),
  );
  eq("签到日数（每人最近一段连续，独立推导）", expectedChecks.size, actualChecks.size);
  const diff = [...expectedChecks].filter((k) => !actualChecks.has(k)).length;
  add("签到日集合与独立推导逐项一致", diff === 0, `缺 ${diff}`);
}

group = "徽章";
{
  eq(
    "徽章数 = 旧勋章 + 团队徽章",
    (await num("SELECT COUNT(*) n FROM nw_medal_info")) + TEAM_ROLES.length,
    await num("SELECT COUNT(*) n FROM badges", newQuery),
  );
  const orphan = await num(
    `SELECT COUNT(*) n FROM user_badges ub LEFT JOIN badges b ON b.id = ub.badge_id LEFT JOIN users u ON u.id = ub.user_id
      WHERE b.id IS NULL OR u.id IS NULL`,
    newQuery,
  );
  add("持有关系引用完整", orphan === 0, `悬空 ${orphan}`);
  const teamHolders = await num(
    "SELECT COUNT(*) n FROM user_badges ub JOIN badges b ON b.id = ub.badge_id WHERE b.kind = 'team'",
    newQuery,
  );
  const teamRoles = await num(
    `SELECT COUNT(*) n FROM user_roles WHERE role_key LIKE 'team-%'`,
    newQuery,
  );
  eq("团队徽章持有人 = 团队角色绑定", teamRoles, teamHolders);
}

// ---------- 社交 ----------
group = "社交";
{
  eq(
    "关注用户",
    await num(
      `SELECT COUNT(*) n FROM nw_attention a JOIN nw_user x ON x.uid = a.uid JOIN nw_user y ON y.uid = a.touid
        WHERE a.uid <> a.touid AND a.uid ${NOT_SPAM} AND a.touid ${NOT_SPAM}`,
    ),
    await num("SELECT COUNT(*) n FROM follows WHERE target_type = 'user'", newQuery),
  );
  eq(
    "加入版块",
    await num(
      `SELECT COUNT(*) n FROM nw_bbs_forum_user j JOIN nw_user x ON x.uid = j.uid JOIN nw_bbs_forum f ON f.fid = j.fid
        WHERE j.uid ${NOT_SPAM} AND j.fid IN (${keepFidSql})`,
    ),
    await num("SELECT COUNT(*) n FROM follows WHERE target_type = 'forum'", newQuery),
  );
  const rx = await num(
    `SELECT COUNT(*) n FROM reactions r LEFT JOIN posts p ON p.id = r.post_id LEFT JOIN users u ON u.id = r.user_id
      WHERE p.id IS NULL OR u.id IS NULL`,
    newQuery,
  );
  add("点赞引用完整", rx === 0, `悬空 ${rx}`);
  const likeSum = await num("SELECT COALESCE(SUM(like_count), 0) n FROM posts", newQuery);
  eq(
    "posts.like_count 之和 = 点赞明细数",
    await num("SELECT COUNT(*) n FROM reactions", newQuery),
    likeSum,
  );

  eq(
    "投票数（对应主题已迁移）",
    await num(
      `SELECT COUNT(DISTINCT pt.poll_id) n FROM nw_app_poll_thread pt
        JOIN nw_app_poll p ON p.poll_id = pt.poll_id JOIN nw_bbs_threads t ON t.tid = pt.tid
        WHERE ${EXP_THREAD}`,
    ),
    await num("SELECT COUNT(*) n FROM polls", newQuery),
  );
  const voteSum = await num(
    `SELECT COUNT(*) n FROM polls p WHERE p.voter_count <> (SELECT COUNT(DISTINCT user_id) FROM poll_votes v WHERE v.poll_id = p.id)`,
    newQuery,
  );
  add("投票人数 = 实际投票人数", voteSum === 0, `不一致 ${voteSum}`);
  const optSum = await num(
    `SELECT COUNT(*) n FROM poll_options o WHERE o.vote_count <> (SELECT COUNT(*) FROM poll_votes v WHERE v.option_id = o.id)`,
    newQuery,
  );
  add("选项票数 = 实际票数", optSum === 0, `不一致 ${optSum}`);

  const pm = await num(
    "SELECT (SELECT COUNT(*) FROM messages) + (SELECT COUNT(*) FROM conversations) AS n",
    newQuery,
  );
  add("私信不迁（会话与消息表为空）", pm === 0, `残留 ${pm}`);
}

// ---------- 计数 ----------
group = "计数";
{
  const t = await num(
    `SELECT COUNT(*) n FROM threads t
      WHERE t.reply_count <> (SELECT COUNT(*) FROM posts p WHERE p.thread_id = t.id AND p.floor > 1 AND p.state = 'visible')`,
    newQuery,
  );
  add("主题 reply_count = 可见回帖数", t === 0, `不一致 ${t}`);
  eq(
    "版块 thread_count 之和 = 可见主题数",
    await num("SELECT COUNT(*) n FROM threads WHERE state = 'visible'", newQuery),
    await num("SELECT COALESCE(SUM(thread_count), 0) n FROM forums", newQuery),
  );
  eq(
    "user_stats 覆盖全部用户",
    await num("SELECT COUNT(*) n FROM users", newQuery),
    await num("SELECT COUNT(*) n FROM user_stats", newQuery),
  );
  eq(
    "user_stats.featured_count 之和 = 精华主题数",
    await num("SELECT COUNT(*) n FROM threads WHERE is_featured = 1", newQuery),
    await num("SELECT COALESCE(SUM(featured_count), 0) n FROM user_stats", newQuery),
  );
}

// ---------- 输出 ----------
const report = new Report("迁移 v2 对账报告", [
  `基准时间：${AS_OF}`,
  "期望值由与迁移实现不同的路径（直接对旧库写 SQL）独立推导。内容确定性，入库留档。",
]);
const groups = [...new Set(checks.map((c) => c.group))];
for (const g of groups) {
  const s = report.section(g);
  s.table(
    ["检查", "结果", "详情"],
    checks.filter((c) => c.group === g).map((c) => [c.name, c.pass ? "✔" : "✘", c.detail]),
  );
}
report.save(join(config.reportDir, "migration-v2-verify.md"));

console.log("\n========== 迁移 v2 对账 ==========");
let fails = 0;
for (const c of checks) {
  if (!c.pass) fails++;
  console.log(`${c.pass ? "✔" : "✘"} [${c.group}] ${c.name.padEnd(34)} ${c.detail}`);
}
console.log("==================================");
console.log(fails === 0 ? `全部通过（${checks.length} 项）` : `失败 ${fails}/${checks.length} 项`);
await closePools();
process.exit(fails === 0 ? 0 : 1);
