// @vitest-environment node
import { getTableName, type SQL, type Table } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { describe, expect, it } from "vitest";
import type { DbTx } from "@/lib/audit";
import { purgeUserDataInTx, revertUserPollVotes } from "./account-deletion-purge";

const dialect = new MySqlDialect();
const compile = (expression: SQL) => dialect.sqlToQuery(expression);
type Write = {
  table: string;
  kind: "delete" | "update";
  values: Record<string, unknown>;
  where: SQL;
};

/** 只接受传入事务的写入，记录删表/清理列清单与顺序，不访问任何数据库。 */
function recordTransaction(votes: { pollId: number; optionId: number; count: number }[] = []) {
  const writes: Write[] = [];
  const tx = {
    select: () => ({ from: () => ({ where: () => ({ groupBy: async () => votes }) }) }),
    delete: (table: Table) => ({
      where: async (where: SQL) => {
        writes.push({ table: getTableName(table), kind: "delete", values: {}, where });
      },
    }),
    update: (table: Table) => ({
      set: (values: Record<string, unknown>) => ({
        where: async (where: SQL) => {
          writes.push({ table: getTableName(table), kind: "update", values, where });
        },
      }),
    }),
  } as unknown as DbTx;
  return { tx, writes };
}

describe("注销清理清单守卫", () => {
  it("保留原删表、匿名化列与写入顺序；不会扩展到内容、文件、台账或申请表", async () => {
    const { tx, writes } = recordTransaction();
    await purgeUserDataInTx(tx, 42);
    expect(
      writes.map((write) => `${write.kind}:${write.table}:${Object.keys(write.values).join(",")}`),
    ).toEqual([
      "delete:sessions:",
      "delete:email_tokens:",
      "delete:account_deletion_tokens:",
      "delete:user_roles:",
      "delete:user_restrictions:",
      "delete:user_badges:",
      "delete:notification_preferences:",
      "delete:announcement_reads:",
      "delete:checkins:",
      "delete:point_accounts:",
      "delete:user_stats:",
      "delete:file_uploads:",
      "delete:gate_unlocks:",
      "delete:reactions:",
      "delete:poll_votes:",
      "delete:follows:",
      "delete:notifications:",
      "update:notifications:actorId,data",
      "update:invite_codes:createdBy",
      "update:invite_codes:usedBy",
      "update:reports:reason",
      "update:reports:handledNote",
      "update:user_appeals:reason,result",
      "delete:user_profiles:",
      "update:audit_log:beforeJson,afterJson,ip",
      "update:event_log:payload,errorJson",
      "delete:event_outbox:",
      "update:messages:senderId",
      "update:users:username,usernameKey,email,emailKey,passwordHash,legacyPasswordHash,legacyPasswordPending,emailVerifiedAt,emailVerificationRequired,loginVerificationRequired,lastLoginAt,lastEmailDigestAt,state",
    ]);
    expect(writes.find((write) => write.table === "users")?.values).toEqual({
      username: "已注销用户#42",
      usernameKey: "deleted:42",
      email: null,
      emailKey: null,
      passwordHash: null,
      legacyPasswordHash: null,
      legacyPasswordPending: false,
      emailVerifiedAt: null,
      emailVerificationRequired: false,
      loginVerificationRequired: false,
      lastLoginAt: null,
      lastEmailDigestAt: null,
      state: "deleted",
    });
    expect(writes.find((write) => write.table === "audit_log")?.values).toEqual({
      beforeJson: null,
      afterJson: null,
      ip: null,
    });
    expect(writes.find((write) => write.table === "event_log")?.values).toEqual({
      payload: { redacted: true },
      errorJson: null,
    });
    const followWhere = compile(writes.find((write) => write.table === "follows")!.where);
    expect(followWhere.params).toEqual([42, "user", 42]);
  });

  it("审计关联条件、事件 PII 键和 outbox 的清理范围保持一致", async () => {
    const { tx, writes } = recordTransaction();
    await purgeUserDataInTx(tx, 42);
    const auditWhere = compile(writes.find((write) => write.table === "audit_log")!.where);
    expect(auditWhere.params).toEqual([42, "user", "42", 42, 42]);
    for (const table of ["event_log", "event_outbox"]) {
      const query = compile(writes.find((write) => write.table === table)!.where);
      const keys = [...query.sql.matchAll(/JSON_OBJECT\('([^']+)'/g)].map((match) => match[1]);
      expect(keys).toEqual([
        "userId",
        "authorId",
        "senderId",
        "recipientId",
        "operatorId",
        "editorId",
        "mentionedUserId",
        "createdBy",
        "uploaderId",
        "threadAuthorId",
        "replyToAuthorId",
        "targetType",
      ]);
      expect(query.sql).toContain("'targetType', 'user', 'targetId'");
      expect(query.params).toEqual(Array(13).fill(42));
    }
  });

  it("多个选项先回退各选项票数，同一投票仅回退一次人数，全部沿用传入事务", async () => {
    const { tx, writes } = recordTransaction([
      { pollId: 7, optionId: 71, count: 2 },
      { pollId: 7, optionId: 72, count: 1 },
      { pollId: 8, optionId: 81, count: 1 },
    ]);
    await revertUserPollVotes(tx, 42);
    expect(writes.map((write) => [write.table, compile(write.where).params])).toEqual([
      ["poll_options", [71]],
      ["poll_options", [72]],
      ["poll_options", [81]],
      ["polls", [7]],
      ["polls", [8]],
    ]);
    expect(
      writes.slice(0, 3).map((write) => compile(write.values.voteCount as SQL).params),
    ).toEqual([[2], [1], [1]]);
    expect(writes.slice(3).map((write) => compile(write.values.voterCount as SQL).sql)).toEqual([
      "GREATEST(`polls`.`voter_count` - 1, 0)",
      "GREATEST(`polls`.`voter_count` - 1, 0)",
    ]);
  });
});
