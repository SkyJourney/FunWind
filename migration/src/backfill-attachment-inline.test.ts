import { describe, expect, it } from "vitest";
import {
  backfillAttachmentInline,
  type BackfillConnection,
  type BackfillDatabase,
} from "./backfill-attachment-inline.js";

const attachmentCounts = new Map([
  [11, 2],
  [24, 1],
  [37, 3],
]);

function fakeDatabase() {
  const updated = new Map<number, number>();
  const audited = new Set<number>();
  let failAudit = true;
  let transactions = 0;

  const database: BackfillDatabase = {
    query: async <T>(sql: string, params: unknown[] = []) => {
      if (sql.includes("SELECT DISTINCT a.post_id")) {
        const lastPostId = Number(params[0]);
        const limit = Number(params[1]);
        return [...attachmentCounts.keys()]
          .filter((postId) => postId > lastPostId && !updated.has(postId))
          .slice(0, limit)
          .map((post_id) => ({ post_id })) as T[];
      }
      if (sql.includes("COUNT(*) AS remain")) {
        const remain = [...attachmentCounts.keys()].filter((postId) => !updated.has(postId)).length;
        return [{ remain }] as T[];
      }
      throw new Error(`测试数据库收到未预期的查询: ${sql}`);
    },
    transaction: async <T>(run: (connection: BackfillConnection) => Promise<T>) => {
      transactions++;
      const pendingUpdates = new Map<number, number>();
      const pendingAudits = new Set<number>();
      const connection: BackfillConnection = {
        query: async (sql: string, params: unknown[] = []) => {
          const postId = Number(params[0]);
          if (sql.trimStart().startsWith("UPDATE attachments")) {
            const count = updated.has(postId) ? 0 : (attachmentCounts.get(postId) ?? 0);
            if (count > 0) pendingUpdates.set(postId, count);
            return { affectedRows: count };
          }
          if (sql.trimStart().startsWith("INSERT INTO audit_log")) {
            if (failAudit) {
              failAudit = false;
              throw new Error("注入的审计写入失败");
            }
            pendingAudits.add(postId);
            return { affectedRows: 1 };
          }
          throw new Error(`测试事务收到未预期的语句: ${sql}`);
        },
      };
      const result = await run(connection);
      for (const [postId, count] of pendingUpdates) updated.set(postId, count);
      for (const postId of pendingAudits) audited.add(postId);
      return result;
    },
  };

  return {
    database,
    updated,
    audited,
    transactionCount: () => transactions,
    resetTransactionCount: () => {
      transactions = 0;
    },
  };
}

describe("附件内联 backfill", () => {
  it("按帖子分批，更新失败时同批审计与更新一起回滚，重跑可补齐", async () => {
    const fake = fakeDatabase();
    await expect(backfillAttachmentInline(fake.database, 2)).rejects.toThrow("注入的审计写入失败");
    expect(fake.updated.size).toBe(0);
    expect(fake.audited.size).toBe(0);

    fake.resetTransactionCount();
    const result = await backfillAttachmentInline(fake.database, 2);
    expect(result).toEqual({ converted: 6, auditedPosts: 3, remaining: 0 });
    expect(fake.transactionCount()).toBe(2);
    expect([...fake.updated.keys()]).toEqual([11, 24, 37]);
    expect([...fake.audited]).toEqual([11, 24, 37]);
  });
});
