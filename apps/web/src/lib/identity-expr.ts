import { sql, type AnyColumn } from "drizzle-orm";

/** 状态列或已完成注销 tombstone 任一成立时，统一视为公开匿名身份。 */
export const publicUserDeleted = (userId: AnyColumn, state: AnyColumn) =>
  sql<boolean>`(${userId} IS NOT NULL AND (
    ${state} IS NULL OR ${state} = 'deleted' OR EXISTS (
      SELECT 1 FROM account_deletion_requests adr
      WHERE adr.user_id = ${userId} AND adr.status = 'completed'
    )
  ))`;

/** 公共身份名：注销身份永远只呈现统一匿名名称。 */
export const publicUsername = (username: AnyColumn, state: AnyColumn, userId: AnyColumn) =>
  sql<
    string | null
  >`CASE WHEN ${publicUserDeleted(userId, state)} THEN '已注销用户' ELSE ${username} END`;

/** 公共身份不暴露已注销用户的 UID。 */
export const publicUserId = (userId: AnyColumn, state: AnyColumn) =>
  sql<number | null>`CASE WHEN ${publicUserDeleted(userId, state)} THEN NULL ELSE ${userId} END`;
