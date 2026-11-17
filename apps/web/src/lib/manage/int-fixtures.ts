import "server-only";

import { sql } from "drizzle-orm";
import { getWebDb, userRoles, users } from "@funwind/db";
import { hashPassword } from "@/lib/auth/password";

/**
 * manage 模块 int 测试共享夹具（tokens.int.test.ts / guard.int.test.ts）。
 * 临时库由各测试文件自己 setupTempDb 建立（NEW_DB_NAME 指向随机库）。
 */

/** 全程不动的「另一位有效管理员」：兜底不变量断言（demo 种子 admin@0 + 双持授权） */
export const FIXTURE_ACTOR_ID = 90004;

let nextUid = 91001;

export async function makeActiveUser(username: string): Promise<number> {
  const uid = nextUid++;
  await getWebDb()
    .insert(users)
    .values({
      id: uid,
      username,
      usernameKey: username,
      email: `${username}@test.local`,
      emailKey: `${username}@test.local`,
      passwordHash: await hashPassword("test-pass"),
      emailVerifiedAt: "2026-11-17 00:00:00",
      state: "active",
      createdAt: "2026-11-17 00:00:00",
    });
  return uid;
}

/** 造一位满足站点管理员不变量的用户（active + 有密码 + 绑 admin@0；bootstrap 已给 admin 角色双持授权） */
export async function makeSiteAdmin(username: string): Promise<number> {
  const uid = await makeActiveUser(username);
  await getWebDb()
    .insert(userRoles)
    .values({ userId: uid, roleKey: "admin", scopeId: 0, grantedAt: sql`NOW()` });
  return uid;
}
