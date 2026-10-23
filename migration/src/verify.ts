/**
 * 迁移 v2 对账：旧库（只读） ⇄ 新库。
 * 原则：期望值尽量用与迁移实现**不同的路径**独立推导（直接对旧库写 SQL），
 * 避免「实现和检查共用同一段逻辑，错了也是一致的」。
 * 输出：控制台 + docs/reports/migration-v2-verify.md（确定性，入库）。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PERMISSION_DEFINITIONS, ROLE_DEFINITIONS } from "@funwind/db";
import { AS_OF, config } from "./config.js";
import { closePools, newQuery, oldQuery } from "./db.js";
import { Report } from "./lib/report.js";
import { MEMBER_GIDS } from "./transform/legacy-groups.js";

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

// ---------- 用户 ----------
group = "用户";
{
  eq(
    "行数 users",
    await num("SELECT COUNT(*) n FROM nw_user"),
    await num("SELECT COUNT(*) n FROM users", newQuery),
  );
  eq(
    "行数 user_profiles",
    await num("SELECT COUNT(*) n FROM nw_user"),
    await num("SELECT COUNT(*) n FROM user_profiles", newQuery),
  );
  const [u] = await newQuery<{
    n: number;
    uk: number;
    ek: number;
    nopw: number;
    nodate: number;
  }>(
    `SELECT COUNT(*) n, COUNT(DISTINCT username_key) uk, COUNT(email_key) ek,
            COUNT(DISTINCT email_key) dek, SUM(password_hash IS NOT NULL) nopw,
            SUM(created_at IS NULL) nodate FROM users`,
  );
  add("用户名归一化键唯一", Number(u!.uk) === Number(u!.n), `${u!.uk}/${u!.n}`);
  const dek = await num("SELECT COUNT(DISTINCT email_key) n FROM users", newQuery);
  add("邮箱归一化键唯一", dek === Number(u!.ek), `${dek}/${u!.ek}`);
  add("密码哈希一律为空（红线）", Number(u!.nopw) === 0, `非空 ${u!.nopw}`);
  add("注册时间无空值", Number(u!.nodate) === 0, `空 ${u!.nodate}`);

  // 平假名/片假名账号都在（旧站 EUC-JP 实测红线：さくら≠サクラ）
  const kana = await num(
    "SELECT COUNT(*) n FROM users WHERE username IN ('さくら','サクラ')",
    newQuery,
  );
  const kanaOld = await num("SELECT COUNT(*) n FROM nw_user WHERE username IN ('さくら','サクラ')");
  eq("假名用户名不碰撞", kanaOld, kana);

  // 头像：avatar_key 非空的文件必须真实存在；旧站有主图文件的用户都要带上
  const withAvatar = await newQuery<{ id: number; avatar_key: string }>(
    "SELECT user_id AS id, avatar_key FROM user_profiles WHERE avatar_key IS NOT NULL",
  );
  const missing = withAvatar.filter((r) => !existsSync(join(config.attachmentDir, r.avatar_key)));
  add("头像文件均存在", missing.length === 0, `${withAvatar.length} 个，缺失 ${missing.length}`);

  const spamNew = await num("SELECT COUNT(*) n FROM users WHERE state = 'spam'", newQuery);
  const spamOld = await num(`SELECT COUNT(*) n FROM (
      SELECT t.created_userid uid FROM nw_bbs_threads t
      LEFT JOIN nw_bbs_threads_content c ON c.tid = t.tid
      WHERE c.tid IS NULL AND NOT EXISTS (SELECT 1 FROM nw_bbs_posts p WHERE p.tid = t.tid)
        AND EXISTS (SELECT 1 FROM nw_user u WHERE u.uid = t.created_userid)
        AND NOT EXISTS (SELECT 1 FROM nw_bbs_posts p2 WHERE p2.created_userid = t.created_userid)
        AND NOT EXISTS (SELECT 1 FROM nw_bbs_threads t2 JOIN nw_bbs_threads_content c2 ON c2.tid = t2.tid
                        WHERE t2.created_userid = t.created_userid)
      GROUP BY t.created_userid) x`);
  eq("spam 用户数（独立 SQL 推导）", spamOld, spamNew);
}

// ---------- 版块 ----------
group = "版块";
{
  eq(
    "行数 forums",
    await num("SELECT COUNT(*) n FROM nw_bbs_forum"),
    await num("SELECT COUNT(*) n FROM forums", newQuery),
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

  // 读策略：独立用 FIND_IN_SET 推导期望的 public/members/restricted 数量
  const memberAny = [...MEMBER_GIDS].map((g) => `FIND_IN_SET(${g}, allow_read)`).join(" OR ");
  const expPublic = await num(
    `SELECT COUNT(*) n FROM nw_bbs_forum WHERE allow_read <> '' AND FIND_IN_SET(2, allow_read)`,
  );
  const expMembers = await num(
    `SELECT COUNT(*) n FROM nw_bbs_forum WHERE allow_read <> '' AND NOT FIND_IN_SET(2, allow_read) AND (${memberAny})`,
  );
  const expRestricted = await num(
    `SELECT COUNT(*) n FROM nw_bbs_forum WHERE allow_read <> '' AND NOT FIND_IN_SET(2, allow_read) AND NOT (${memberAny})`,
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
    await num("SELECT COUNT(*) n FROM nw_bbs_forum WHERE isshow = 0"),
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
        WHERE b.typeid = 1 AND (b.end_time = 0 OR b.end_time > ?)
       UNION
       SELECT uid FROM nw_user WHERE groupid = 6
       UNION
       SELECT bl.uid FROM nw_user_belong bl JOIN nw_user u ON u.uid = bl.uid
        WHERE bl.gid = 6 AND (bl.endtime = 0 OR bl.endtime > ?)
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
          WHERE b.typeid = ? AND (b.end_time = 0 OR b.end_time > ?)`,
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
  for (const role of ROLE_DEFINITIONS.filter((r) => r.key === "admin" || r.kind === "custom")) {
    const gids = role.legacyGids.join(",");
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
