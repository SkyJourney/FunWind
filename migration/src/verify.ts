/**
 * 迁移 v2 对账：旧库（只读） ⇄ 新库。
 * 原则：期望值尽量用与迁移实现**不同的路径**独立推导（直接对旧库写 SQL），
 * 避免「实现和检查共用同一段逻辑，错了也是一致的」。
 * 输出：控制台 + docs/reports/migration-v2-verify.md（确定性，入库）。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PERMISSION_DEFINITIONS } from "@funwind/db";
import { BUILTIN_GIDS, TEAM_ROLES } from "./mapping/legacy-roles.js";
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
  const shellSql = `NOT EXISTS (SELECT 1 FROM nw_bbs_threads_content c WHERE c.tid = t.tid)
     AND NOT EXISTS (SELECT 1 FROM nw_bbs_posts p WHERE p.tid = t.tid)`;
  const oldThreads = await num("SELECT COUNT(*) n FROM nw_bbs_threads");
  eq(
    "行数 threads（含改挂归档版块的主题）",
    oldThreads,
    await num("SELECT COUNT(*) n FROM threads", newQuery),
  );
  eq(
    "spam 空壳主题",
    await num(`SELECT COUNT(*) n FROM nw_bbs_threads t WHERE ${shellSql}`),
    await num("SELECT COUNT(*) n FROM threads WHERE state = 'spam'", newQuery),
  );
  eq(
    "首帖数 = 非 spam 主题数",
    await num("SELECT COUNT(*) n FROM threads WHERE state <> 'spam'", newQuery),
    await num("SELECT COUNT(*) n FROM posts WHERE floor = 1", newQuery),
  );
  eq(
    "回帖数（旧回帖 − 孤儿/空壳下的回帖）",
    await num(
      `SELECT COUNT(*) n FROM nw_bbs_posts p JOIN nw_bbs_threads t ON t.tid = p.tid
        WHERE NOT (${shellSql})`,
    ),
    await num("SELECT COUNT(*) n FROM posts WHERE floor > 1", newQuery),
  );
  const gaps = await num(
    "SELECT COUNT(*) n FROM (SELECT thread_id FROM posts GROUP BY thread_id HAVING COUNT(*) <> MAX(floor)) x",
    newQuery,
  );
  add("楼层连续（无断层、无重复）", gaps === 0, `断层主题 ${gaps}`);
  const badFirst = await num(
    `SELECT COUNT(*) n FROM threads t LEFT JOIN posts p ON p.id = t.first_post_id AND p.floor = 1 AND p.thread_id = t.id
      WHERE t.state <> 'spam' AND p.id IS NULL`,
    newQuery,
  );
  add("非 spam 主题都有 floor=1 的首帖", badFirst === 0, `缺首帖 ${badFirst}`);
  eq(
    "回收站(disabled>0)主题 → deleted",
    await num(`SELECT COUNT(*) n FROM nw_bbs_threads t WHERE t.disabled > 0 AND NOT (${shellSql})`),
    await num("SELECT COUNT(*) n FROM threads WHERE state = 'deleted'", newQuery),
  );
  eq(
    "回收站/屏蔽回帖状态",
    await num(
      `SELECT COUNT(*) n FROM nw_bbs_posts p JOIN nw_bbs_threads t ON t.tid = p.tid
        WHERE (p.disabled > 0 OR p.ifshield > 0) AND NOT (${shellSql})`,
    ),
    await num(
      "SELECT COUNT(*) n FROM posts WHERE floor > 1 AND state IN ('deleted','hidden')",
      newQuery,
    ),
  );
  const orphanFk = await num(
    `SELECT (SELECT COUNT(*) FROM posts p LEFT JOIN threads t ON t.id = p.thread_id WHERE t.id IS NULL)
          + (SELECT COUNT(*) FROM threads t LEFT JOIN forums f ON f.id = t.forum_id WHERE f.id IS NULL)
          + (SELECT COUNT(*) FROM attachments a LEFT JOIN posts p ON p.id = a.post_id WHERE p.id IS NULL) AS n`,
    newQuery,
  );
  add("引用完整（帖→主题、主题→版块、附件→帖）", orphanFk === 0, `悬空 ${orphanFk}`);

  // 附件：主题存在且非空壳
  eq(
    "附件数",
    await num(
      `SELECT COUNT(*) n FROM nw_attachs_thread a JOIN nw_bbs_threads t ON t.tid = a.tid WHERE NOT (${shellSql})`,
    ),
    await num("SELECT COUNT(*) n FROM attachments", newQuery),
  );
  const atts = await newQuery<{ storage_key: string }>("SELECT storage_key FROM attachments");
  const attMissing = atts.filter((a) => !existsSync(join(config.attachmentDir, a.storage_key)));
  add(
    "附件文件在磁盘上",
    attMissing.length <= 1,
    `缺失 ${attMissing.length}/${atts.length}（旧站源盘本就缺 1 个）`,
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

  // 占位 ⇄ 门控一一对应
  const withGate = await newQuery<{ id: number; body_md: string }>(
    "SELECT id, body_md FROM posts WHERE has_gate = 1",
  );
  const gatesOf = new Map<number, Set<number>>();
  for (const g of await newQuery<{ id: number; post_id: number }>(
    "SELECT id, post_id FROM post_gates",
  )) {
    const set = gatesOf.get(Number(g.post_id)) ?? new Set<number>();
    set.add(Number(g.id));
    gatesOf.set(Number(g.post_id), set);
  }
  let badPlaceholders = 0;
  const examples: number[] = [];
  for (const p of withGate) {
    const inBody = new Set(
      [...p.body_md.matchAll(/:::gate\{id="(\d+)"\}/g)].map((m) => Number(m[1])),
    );
    const inDb = gatesOf.get(Number(p.id)) ?? new Set<number>();
    const same = inBody.size === inDb.size && [...inBody].every((id) => inDb.has(id));
    if (!same) {
      badPlaceholders++;
      if (examples.length < 5) examples.push(Number(p.id));
    }
  }
  add(
    "正文占位与 post_gates 一一对应",
    badPlaceholders === 0,
    badPlaceholders ? `不一致 ${badPlaceholders} 帖: ${examples}` : `${withGate.length} 帖全部一致`,
  );

  const badUnlock = await num(
    `SELECT COUNT(*) n FROM gate_unlocks u
      LEFT JOIN post_gates g ON g.id = u.gate_id LEFT JOIN users x ON x.id = u.user_id
      WHERE g.id IS NULL OR x.id IS NULL`,
    newQuery,
  );
  add("解锁记录引用完整", badUnlock === 0, `悬空 ${badUnlock}`);
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
  for (const r of await oldQuery<{ c: string }>("SELECT content AS c FROM nw_bbs_threads_content"))
    src += cjk(stripUbb(r.c ?? ""));
  for (const r of await oldQuery<{ c: string }>(
    `SELECT p.content AS c FROM nw_bbs_posts p JOIN nw_bbs_threads t ON t.tid = p.tid`,
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

  // 独立推导：旧 credit1（非负，仅已迁用户）+ 银行存款本金（仅已迁用户）
  const expected = await num(
    `SELECT (SELECT COALESCE(SUM(GREATEST(d.credit1, 0)), 0) FROM nw_user_data d JOIN nw_user u ON u.uid = d.uid)
          + (SELECT COALESCE(SUM(GREATEST(b.deposit, 0) + GREATEST(b.ddeposit, 0)), 0) FROM nw_app_bank b JOIN nw_user u ON u.uid = b.uid) AS n`,
  );
  eq("期初余额总额（旧 credit1 + 银行本金，独立 SQL）", expected, Number(sums[0]!.accounts));
  const neg = await num("SELECT COUNT(*) n FROM point_accounts WHERE balance < 0", newQuery);
  add("没有负余额", neg === 0, `负余额 ${neg}`);

  eq(
    "签到次数（用户×北京时间自然日，独立 SQL）",
    await num(
      `SELECT COUNT(*) n FROM (
         SELECT l.created_userid, DATE(DATE_ADD('1970-01-01', INTERVAL l.created_time + 28800 SECOND)) d
         FROM nw_credit_log l JOIN nw_user u ON u.uid = l.created_userid
         WHERE l.logtype = 'punch' GROUP BY l.created_userid, d) x`,
    ),
    await num("SELECT COUNT(*) n FROM checkins", newQuery),
  );
}

group = "徽章";
{
  eq(
    "徽章数 = 旧勋章 + 团队徽章",
    (await num("SELECT COUNT(*) n FROM nw_medal_info")) + 6,
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
      `SELECT COUNT(*) n FROM nw_attention a JOIN nw_user x ON x.uid = a.uid JOIN nw_user y ON y.uid = a.touid WHERE a.uid <> a.touid`,
    ),
    await num("SELECT COUNT(*) n FROM follows WHERE target_type = 'user'", newQuery),
  );
  eq(
    "加入版块",
    await num(
      `SELECT COUNT(*) n FROM nw_bbs_forum_user j JOIN nw_user x ON x.uid = j.uid JOIN nw_bbs_forum f ON f.fid = j.fid`,
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
    "投票主题数（对应主题存在且非空壳）",
    await num(
      `SELECT COUNT(DISTINCT pt.poll_id) n FROM nw_app_poll_thread pt
        JOIN nw_app_poll p ON p.poll_id = pt.poll_id JOIN nw_bbs_threads t ON t.tid = pt.tid
        WHERE NOT (${shellSql2()})`,
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

  eq(
    "真实用户私信条数（独立 SQL）",
    await num(
      `SELECT COUNT(*) n FROM nw_windid_message m JOIN nw_user a ON a.uid = m.from_uid JOIN nw_user b ON b.uid = m.to_uid
        WHERE m.from_uid <> m.to_uid AND TRIM(m.content) <> ''`,
    ),
    await num("SELECT COUNT(*) n FROM messages", newQuery),
  );
  const badConv = await num(
    `SELECT COUNT(*) n FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE c.pair_key NOT REGEXP CONCAT('(^|:)', m.sender_id, '(:|$)')`,
    newQuery,
  );
  add("消息发送者属于所在会话", badConv === 0, `异常 ${badConv}`);
  const members = await num(
    `SELECT COUNT(*) n FROM conversations c WHERE (SELECT COUNT(*) FROM conversation_members m WHERE m.conversation_id = c.id) <> 2`,
    newQuery,
  );
  add("每个会话恰有 2 名成员", members === 0, `异常 ${members}`);
}

// ---------- 计数 ----------
group = "计数";
{
  const t = await num(
    `SELECT COUNT(*) n FROM threads t WHERE t.state <> 'spam'
       AND t.reply_count <> (SELECT COUNT(*) FROM posts p WHERE p.thread_id = t.id AND p.floor > 1 AND p.state = 'visible')`,
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
}

/** 空壳主题条件（别名 t 指向 nw_bbs_threads） */
function shellSql2() {
  return `NOT EXISTS (SELECT 1 FROM nw_bbs_threads_content c WHERE c.tid = t.tid) AND NOT EXISTS (SELECT 1 FROM nw_bbs_posts p WHERE p.tid = t.tid)`;
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
