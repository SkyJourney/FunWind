import { cache } from "react";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { getWebDb, userRestrictions, userRoles, users } from "@funwind/db";
import { getCurrentUser } from "@/lib/auth/session";
import { getRegisterMode } from "@/lib/auth/settings";
import { restrictionActive } from "./restrictions";
import { GUEST_SUBJECT, type Subject } from "./types";

/**
 * 评估主体的加载。显式按 userId 加载——评估入口绝不隐式读取“当前请求用户”（M5 的 checkPermission 缺陷）。
 * 过期的角色绑定与未生效/已结束的限制在这里过滤，评估器只看当下有效的。
 */

/** 加载指定用户的主体；null、不存在、已注销的账号一律按游客 */
export async function loadSubject(userId: number | null): Promise<Subject> {
  const registerMode = await getRegisterMode();
  if (userId === null) return { ...GUEST_SUBJECT, registerMode };

  const db = getWebDb();
  const [userRows, roleRows, restrictionRows] = await Promise.all([
    db
      .select({ emailVerifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.state, "active")))
      .limit(1),
    db
      .select({ key: userRoles.roleKey, scopeId: userRoles.scopeId })
      .from(userRoles)
      .where(
        and(
          eq(userRoles.userId, userId),
          or(isNull(userRoles.expiresAt), sql`${userRoles.expiresAt} > NOW()`),
        ),
      ),
    db
      .select({
        kind: userRestrictions.kind,
        scopeId: userRestrictions.scopeId,
        endsAt: userRestrictions.endsAt,
      })
      .from(userRestrictions)
      .where(and(eq(userRestrictions.userId, userId), restrictionActive)),
  ]);

  const user = userRows[0];
  if (!user) return { ...GUEST_SUBJECT, registerMode };

  return {
    userId,
    // 登录用户隐含 member@0；显式绑定的 guest/member 无意义，忽略以免重复
    roles: [
      { key: "member", scopeId: 0 },
      ...roleRows.filter((r) => r.key !== "member" && r.key !== "guest"),
    ],
    restrictions: restrictionRows,
    emailVerified: user.emailVerifiedAt !== null,
    registerMode,
  };
}

/** 当前请求用户的主体（请求级缓存） */
export const getCurrentSubject = cache(async (): Promise<Subject> => {
  const user = await getCurrentUser();
  return loadSubject(user?.id ?? null);
});
