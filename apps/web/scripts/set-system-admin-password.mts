#!/usr/bin/env node
/**
 * 系统级兜底超管密码设置（M13 上线后一次性脚本，站长 2026-11-08 拍板）：
 *
 * 「青翼」（uid=5097）= 旧站 phpwind 站点所有者组（gid=3「<(= ‵▽′)ψ大魔王」）的代表账号，
 * 保留 admin 角色，作为**站点级兜底超管**——全站未来除站长（SkyJourney）外的唯一超管入口。
 * 该账号无邮箱（旧站如此），因此密码是它唯一的凭据：设置后写入 argon2id 哈希，
 * 并清除旧站 md5 哈希材料（旧凭据立即失效——留着等于保留一个可被撞库的入口）。
 *
 * 用法（env 指向目标库）：
 *   node --import ./scripts/server-only-register.mjs --import tsx scripts/set-system-admin-password.mts <新密码> [--uid=5097]
 *
 * 审计：action = admin.roles.system-admin-password（actor NULL = CLI）。
 */
import { sql } from "drizzle-orm";
import { auditLog, getWebDb, users } from "@funwind/db";
import { hashPassword } from "../src/lib/auth/password";

const args = process.argv.slice(2);
const uidArg = args.find((a) => a.startsWith("--uid="));
const password = args.find((a) => !a.startsWith("--"));
const uid = uidArg ? Number(uidArg.split("=")[1]) : 5097;

if (!password || password.length < 12) {
  console.error("用法：... set-system-admin-password.mts <新密码（≥12 位）> [--uid=5097]");
  process.exit(1);
}

const db = getWebDb();
const [user] = await db
  .select({ id: users.id, username: users.username, email: users.email })
  .from(users)
  .where(sql`${users.id} = ${uid}`)
  .limit(1);
if (!user) {
  console.error(`用户不存在：${uid}`);
  process.exit(1);
}

const passwordHash = await hashPassword(password);
await db
  .update(users)
  .set({
    passwordHash,
    legacyPasswordHash: null, // 旧站 md5 凭据即刻失效
    legacyPasswordPending: false,
    updatedAt: sql`NOW()`,
  })
  .where(sql`${users.id} = ${uid}`);
await db.insert(auditLog).values({
  actorId: null,
  action: "admin.roles.system-admin-password",
  targetType: "user",
  targetId: String(uid),
  beforeJson: { username: user.username, hadPassword: false, legacyPending: true },
  afterJson: { username: user.username, note: "站点级兜底超管设置现代密码（旧站 md5 凭据已清除）" },
  createdAt: sql`NOW()`,
});
console.log(
  `✔ 已为 #${uid} ${user.username} 设置密码（argon2id）；旧站 md5 凭据已清除；审计已写。`,
);
process.exit(0);
