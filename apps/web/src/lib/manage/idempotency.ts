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

export type ManageIdempotencyOptions = {
  /** 高危写的实时资格复核先于回放与冲突裁决；业务目标仍仅在首次执行时加锁。 */
  authorizeInTx?: (tx: DbTx) => Promise<void>;
  /** 业务字段纳入指纹前的兼容入口，必须从已提交回执独立证实缺失的条件。 */
  legacyReplay?: {
    input: Record<string, unknown>;
    accepts: (response: unknown) => boolean;
  };
};

/** 只规范化对象字段；数组顺序和 JSON 标量保持原语义。 */
function orderJsonObject(_key: string, value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, record[key]]),
  );
}

/** 保留原有外层格式，使不含嵌套对象的旧指纹保持不变。 */
function fingerprint(targetId: number, input: Record<string, unknown>, legacy = false): string {
  const ordered = Object.keys(input)
    .sort()
    .map((key) => [key, input[key]]);
  try {
    return hashToken(JSON.stringify([targetId, ordered], legacy ? undefined : orderJsonObject));
  } catch (error) {
    // 有界 JSON 也可能嵌套过深；不为不可序列化的请求占用幂等键。
    if (error instanceof RangeError) throw new ManageApiError("bad_request");
    throw error;
  }
}

/** 同一事务串行占位、复验对象可访问性、重放或递交变更。失败不会留下成功占位。 */
export async function runIdempotentManageWrite(
  identity: ManageWriteIdentity,
  targetId: number,
  input: Record<string, unknown>,
  lockTarget: ManageWriteWork,
  options: ManageIdempotencyOptions = {},
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
    getWebDb().transaction(
      async (tx) => {
        // 复合主键做唯一串行化点；不存在的行先插入，不能先对空键加范围锁。
        await tx
          .insert(manageApiIdempotency)
          .values({ tokenId, endpoint, keyHash, requestHash, expiresAt })
          .onDuplicateKeyUpdate({ set: { keyHash: sql`${manageApiIdempotency.keyHash}` } });
        await options.authorizeInTx?.(tx);
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

        // 合法回放跳过业务目标锁，避免删除型写首次成功后无法重试；高危写已复核当前身份。
        if (previous.active === 1) {
          if (previous.requestHash !== requestHash) {
            const old = options.legacyReplay;
            const matchesOldReceipt =
              previous.response !== null &&
              previous.requestHash === fingerprint(targetId, old?.input ?? input, true) &&
              (!old || old.accepts(previous.response));
            if (!matchesOldReceipt) throw new ManageApiError("idempotency_conflict");
          }
          if (previous.response !== null)
            return { data: previous.response, afterCommit: undefined };
        }
        // 需要真正执行的新意图：锁内确认目标仍可访问；不拿之前的授权替代当下的判断。
        const execute = await lockTarget(tx);
        const work = await execute();
        await tx
          .update(manageApiIdempotency)
          .set({ requestHash, response: work.data, expiresAt })
          .where(rowKey);
        return work;
      },
      options.authorizeInTx ? { isolationLevel: "read committed" } : undefined,
    ),
  );

  // 提交后的快路径失败不应让调用方误判写入失败；持久化 outbox 仍可补扫。
  try {
    await result.afterCommit?.();
  } catch {
    console.error(`[manage:${endpoint}] 提交后快路径失败`, { requestId });
  }
  return result.data;
}
