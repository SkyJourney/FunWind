#!/usr/bin/env node
/**
 * 管理员角色治理一次性脚本（M13 上线后，站长 2026-11-08 拍板）：
 *
 *   1. **历史管理员降级**：旧站 phpwind 的 admin（站点组 gid=3「<(= ‵▽′)ψ大魔王」）
 *      随迁移整体映射为新站 admin 角色，共 19 个个人账号。新系统由站长（SkyJourney）
 *      与站点身份账号（青翼 uid=5097）维护——旧站权限模型与新站差异很大，个人管理员
 *      全部降级为普通会员（其 team-* 身份保留）。
 *   2. **「青翼」= 站点级兜底超管**：旧站站点所有者组的代表账号（无邮箱、十五年未登录）。
 *      保留其 admin 角色并设为可登录的兜底账号——全站未来唯一的「除站长外的超管入口」。
 *   3. 全部动作写 audit_log（权限变更是该留痕的事）。
 *
 * 用法（容器/生产执行，env 指向生产库）：
 *   node --import ./scripts/server-only-register.mjs --import tsx scripts/admin-roles.ts [--apply]
 *   默认 dry-run（只打印将发生的变更）；--apply 才落库。幂等：可重复执行。
 *
 * 审计：action = admin.roles.demote / admin.roles.site-admin（actor NULL = CLI）。
 */
import { sql } from "drizzle-orm";
import { auditLog, getWebDb, userRoles } from "@funwind/db";

/** 保留 admin 的个人账号：站长本人 */
const KEEP_ADMIN_USER_IDS = [17911];
/** 站点级兜底超管：旧站站点所有者组代表账号（保留 admin，不降级） */
const SITE_ADMIN_USER_ID = 5097;

const apply = process.argv.includes("--apply");

type AdminRow = { id: number; username: string; roles: string };

async function listAdmins(): Promise<AdminRow[]> {
  const rows = await getWebDb().execute(sql`
    SELECT u.id AS id, u.username AS username,
           GROUP_CONCAT(r.role_key ORDER BY r.role_key SEPARATOR ',') AS roles
    FROM users u JOIN user_roles r ON r.user_id = u.id
    WHERE r.role_key = 'admin'
    GROUP BY u.id, u.username
    ORDER BY u.id
  `);
  const list = (Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : rows) as Array<
    Record<string, unknown>
  >;
  return (list ?? []).map((r) => ({
    id: Number(r.id),
    username: String(r.username),
    roles: String(r.roles ?? ""),
  }));
}

async function demote(userId: number, username: string): Promise<number> {
  // 只删 admin 角色行（team-* 保留；重复的 admin 行一并清理）
  const deleted = await getWebDb()
    .delete(userRoles)
    .where(sql`${userRoles.userId} = ${userId} AND ${userRoles.roleKey} = 'admin'`);
  await getWebDb()
    .insert(auditLog)
    .values({
      actorId: null,
      action: "admin.roles.demote",
      targetType: "user",
      targetId: String(userId),
      beforeJson: { username, roleKey: "admin", scopeId: 0 },
      afterJson: { username, note: "旧站管理员降级为普通会员（团队角色保留）" },
      createdAt: sql`NOW()`,
    });
  return deleted.length ?? 0;
}

async function markSiteAdmin(userId: number, username: string): Promise<void> {
  await getWebDb()
    .insert(auditLog)
    .values({
      actorId: null,
      action: "admin.roles.site-admin",
      targetType: "user",
      targetId: String(userId),
      beforeJson: { username, roleKey: "admin" },
      afterJson: {
        username,
        note: "站点级兜底超管（旧站站点所有者组代表账号）；站长之外的唯一超管入口",
      },
      createdAt: sql`NOW()`,
    });
}

const admins = await listAdmins();
console.log(`当前 admin 账号：${admins.length} 个`);
const targets = admins.filter(
  (a) => !KEEP_ADMIN_USER_IDS.includes(a.id) && a.id !== SITE_ADMIN_USER_ID,
);
console.log(`  保留（个人·站长）：${KEEP_ADMIN_USER_IDS.join(", ")}`);
console.log(`  保留（站点级兜底超管）：${SITE_ADMIN_USER_ID} 青翼`);
console.log(`  待降级：${targets.length} 个`);
for (const t of targets) console.log(`    - #${t.id} ${t.username}（其他角色：${t.roles}）`);

if (!apply) {
  console.log("\n[dry-run] 未落库。确认无误后追加 --apply。");
  process.exit(0);
}

let total = 0;
for (const t of targets) {
  const n = await demote(t.id, t.username);
  total += n;
  console.log(`✔ 降级 #${t.id} ${t.username}（删除 admin 行 ${n}）`);
}
await markSiteAdmin(SITE_ADMIN_USER_ID, "青翼");
console.log(`✔ 「青翼」#${SITE_ADMIN_USER_ID} 登记为站点级兜底超管（admin 角色保留）`);
console.log(
  `\n完成：降级 ${targets.length} 个账号、共 ${total} 条 admin 角色行；审计已写 audit_log。`,
);
process.exit(0);
