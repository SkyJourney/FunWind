// @vitest-environment node
/**
 * 新账户并发首次入账的压力回归（审查 P2-16，复查 A6）。
 * 默认 REPEATABLE READ 下，不同用户并发首次建账户会因间隙锁互相死锁：实测 640 次并发 139 次（21.7%）在
 * 3 次重试耗尽后失败。积分 / 解锁事务改用 READ COMMITTED 后应当 0 失败。这是概率性问题，所以用多轮并发压它：
 * 修复前 192 次里几乎不可能 0 失败。
 */
import { sql } from "drizzle-orm";
import { getWebDb } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { applyPoints } from "./apply";

let tdb: TempDb;

describe.skipIf(skipDb)("积分 · 新账户并发首次入账", () => {
  beforeAll(async () => {
    tdb = await setupTempDb();
  });
  afterAll(async () => {
    await tdb?.teardown();
  });

  it("多轮并发为不同的新用户首次入账：全部成功、账户与台账各一条、余额正确", async () => {
    const ROUNDS = 12;
    const PER = 16; // 连接池只有 8 条，16 个并发会排队，更容易交错
    const failures: string[] = [];
    for (let r = 0; r < ROUNDS; r++) {
      const base = 10_000 + r * 100;
      const results = await Promise.allSettled(
        Array.from({ length: PER }, (_, i) =>
          applyPoints({
            userId: base + i,
            channel: "earn.gate_sale",
            delta: 5,
            idempotencyKey: `gap:${base + i}`,
            ref: { type: "gate", id: 1 },
            note: "并发首次入账",
          }),
        ),
      );
      for (const x of results) {
        if (x.status === "rejected")
          failures.push(String((x.reason as Error)?.message ?? x.reason).slice(0, 100));
      }
    }
    expect(failures).toEqual([]);

    const [acc] = (await getWebDb().execute(
      sql`SELECT COUNT(*) AS n, SUM(balance) AS total FROM point_accounts WHERE user_id >= 10000 AND user_id < 20000`,
    )) as unknown as [{ n: number | string; total: number | string }[]];
    expect(Number(acc[0]!.n)).toBe(ROUNDS * PER);
    expect(Number(acc[0]!.total)).toBe(ROUNDS * PER * 5);
    const [led] = (await getWebDb().execute(
      sql`SELECT COUNT(*) AS n FROM point_ledger WHERE idempotency_key LIKE 'gap:%'`,
    )) as unknown as [{ n: number | string }[]];
    expect(Number(led[0]!.n)).toBe(ROUNDS * PER);
  }, 120_000);
});
