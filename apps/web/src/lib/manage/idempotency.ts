import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { getWebDb, manageApiIdempotency } from "@funwind/db";
import type { DbTx } from "@/lib/audit";
import { hashToken } from "@/lib/auth/token";
import { ManageApiError } from "@/lib/manage/errors";
import type { ManageEndpointId } from "@/lib/manage/permissions";
import { withDeadlockRetry } from "@/lib/points/retry";

export type ManageWriteIdentity = {
  tokenId: string;
  endpoint: ManageEndpointId;
  idempotencyKey: string;
  requestId: string;
};

export type ManageWriteWork = (
  tx: DbTx,
) => Promise<() => Promise<{ data: object; afterCommit?: () => Promise<void> }>>;

/** 键、目标 ID 和经验证的业务参数参与指纹；参数字段顺序不影响重放。 */
function fingerprint(targetId: number, input: Record<string, unknown>): string {
  const ordered = Object.keys(input)
    .sort()
    .map((key) => [key, input[key]]);
  return hashToken(JSON.stringify([targetId, ordered]));
}

/** 同一事务串行占位、复验对象可访问性、重放或递交变更。失败不会留下成功占位。 */
export async function runIdempotentManageWrite(
  identity: ManageWriteIdentity,
  targetId: number,
  input: Record<string, unknown>,
  lockTarget: ManageWriteWork,
): Promise<unknown> {
  const { tokenId, endpoint, idempotencyKey, requestId } = identity;
  const keyHash = hashToken(idempotencyKey);
  const requestHash = fingerprint(targetId, input);
  const expiresAt = sql`NOW() + INTERVAL 24 HOUR`;
  const rowKey = and(
    eq(manageApiIdempotency.tokenId, tokenId),
    eq(manageApiIdempotency.endpoint, endpoint),
    eq(manageApiIdempotency.keyHash, keyHash),
  );
  const result = await withDeadlockRetry(() =>
    getWebDb().transaction(async (tx) => {
      // 复合主键做唯一串行化点；不存在的行先插入，不能先对空键加范围锁。
      await tx
        .insert(manageApiIdempotency)
        .values({ tokenId, endpoint, keyHash, requestHash, expiresAt })
        .onDuplicateKeyUpdate({ set: { keyHash: sql`${manageApiIdempotency.keyHash}` } });
      const [previous] = await tx
        .select({
          requestHash: manageApiIdempotency.requestHash,
          response: manageApiIdempotency.response,
          active: sql`${manageApiIdempotency.expiresAt} > NOW()`.mapWith(Number),
        })
        .from(manageApiIdempotency)
        .where(rowKey)
        .for("update");
      if (!previous) throw new ManageApiError("internal");

      // 即使仅取缓存结果，也先确认锁内目标仍可访问；不拿之前的授权替代当下的判断。
      const execute = await lockTarget(tx);
      if (previous.active === 1) {
        if (previous.requestHash !== requestHash) throw new ManageApiError("idempotency_conflict");
        if (previous.response !== null) return { data: previous.response, afterCommit: undefined };
      }
      const work = await execute();
      await tx
        .update(manageApiIdempotency)
        .set({ requestHash, response: work.data, expiresAt })
        .where(rowKey);
      return work;
    }),
  );

  // 提交后的快路径失败不应让调用方误判写入失败；持久化 outbox 仍可补扫。
  try {
    await result.afterCommit?.();
  } catch {
    console.error(`[manage:${endpoint}] 提交后快路径失败`, { requestId });
  }
  return result.data;
}
