// @vitest-environment node
/**
 * M7-1：解锁事务 vs 版主隐藏的**真实并发**测试（两条连接、无测试钩子）。
 * 每轮在独立门控上同时发起「购买」与「隐藏」，提交时刻随机错开， hammering 定位→持锁的窗口：
 *  · 购买成功 ⟹ 解锁记录与台账扣款都在，且 unlocked_at ≤ 隐藏提交时刻（先买后藏）；
 *  · 购买 not_found ⟹ 不扣费、无解锁记录（先藏后买）；
 *  · 不允许出现「扣费而未解锁」「隐藏后仍成功购买」。
 */
import { and, eq } from "drizzle-orm";
import {
  createPool,
  DEMO,
  gateUnlocks,
  getWebDb,
  newDbConfig,
  pointAccounts,
  pointLedger,
  postGates,
  posts,
  threads,
} from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSubject } from "@/lib/authz/subject";
import type { Subject } from "@/lib/authz/types";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { unlockGate } from "./unlock";

let tdb: TempDb;
let team: Subject;
/** 隐藏路径专用连接池（与业务池隔离，模拟第二个人） */
let hidePool: ReturnType<typeof createPool>;
const db = () => getWebDb();

let seq = 0;
/** 造一个带积分门控（价格 1）的主题+首帖，返回 gate id */
async function mkGatedThread(): Promise<number> {
  const tid = 920_000 + ++seq;
  const pid = tid + 100;
  await db()
    .insert(threads)
    .values({
      id: tid,
      forumId: 901,
      authorId: DEMO.alice,
      title: `并发-隐藏 ${tid}`,
      firstPostId: pid,
      state: "visible",
      createdAt: "2026-10-20 00:00:00",
      lastPostedAt: "2026-10-20 00:00:00",
    });
  await db().insert(posts).values({
    id: pid,
    threadId: tid,
    floor: 1,
    authorId: DEMO.alice,
    bodyMd: "并发测试正文",
    state: "visible",
    createdAt: "2026-10-20 00:00:00",
  });
  const [g] = (await db()
    .insert(postGates)
    .values({
      postId: pid,
      gateKey: `c${seq}`,
      conditions: [{ type: "points", price: 1 }],
      matchMode: "all",
      hiddenMd: "隐藏内容",
      createdAt: "2026-10-20 00:00:00",
      updatedAt: "2026-10-20 00:00:00",
    })) as unknown as [{ insertId: number }];
  return Number(g.insertId);
}

/** 第二连接：随机延迟后隐藏主题与首帖，返回库内北京墙面提交时刻 */
async function hideAfter(tid: number, pid: number, delayMs: number): Promise<string> {
  await new Promise((r) => setTimeout(r, delayMs));
  await hidePool.query("UPDATE posts SET state='hidden' WHERE id = ?", [pid]);
  await hidePool.query("UPDATE threads SET state='hidden' WHERE id = ?", [tid]);
  const [rows] = (await hidePool.query("SELECT NOW() AS t")) as unknown as [{ t: string }[]];
  return rows[0].t;
}

beforeAll(async () => {
  tdb = await setupTempDb();
  team = await loadSubject(DEMO.team);
  const cfg = newDbConfig();
  hidePool = createPool(cfg);
});

afterAll(async () => {
  await hidePool.end();
  await tdb?.teardown();
});

describe.skipIf(skipDb)("M7-1 解锁 vs 隐藏真实并发", () => {
  it("15 轮随机交错：购买成功⟹先买后藏且扣款完整；not_found⟹不扣费", async () => {
    const before = await db()
      .select({ balance: pointAccounts.balance })
      .from(pointAccounts)
      .where(eq(pointAccounts.userId, DEMO.team))
      .then((r) => r[0]?.balance ?? 0);

    let purchased = 0;
    let blocked = 0;
    for (let i = 0; i < 15; i++) {
      const gateId = await mkGatedThread();
      const tid = 920_000 + i + 1;
      const pid = tid + 100;
      const delay = Math.floor(Math.random() * 12);
      const [outcome, hiddenAt] = await Promise.all([
        unlockGate(team, gateId, { expectedPrice: 1 }),
        hideAfter(tid, pid, delay),
      ]);

      const [unlockRow] = await db()
        .select()
        .from(gateUnlocks)
        .where(and(eq(gateUnlocks.gateId, gateId), eq(gateUnlocks.userId, DEMO.team)));
      const [spendRow] = await db()
        .select()
        .from(pointLedger)
        .where(
          and(
            eq(pointLedger.userId, DEMO.team),
            eq(pointLedger.channel, "spend.gate_unlock"),
            eq(pointLedger.refId, gateId),
          ),
        );

      if (outcome.ok) {
        purchased++;
        // 扣费而未解锁 → 不允许；解锁记录与台账必须成对存在
        expect(unlockRow, `轮 ${i}：解锁记录`).toBeDefined();
        expect(spendRow, `轮 ${i}：台账扣款`).toBeDefined();
        expect(spendRow.delta).toBe(-1);
        // 隐藏后仍成功购买 → 不允许：成功购买必然先于隐藏提交（先买后藏）
        expect(
          unlockRow.unlockedAt <= hiddenAt,
          `轮 ${i}：unlocked_at=${unlockRow.unlockedAt} 应早于 hidden_at=${hiddenAt}`,
        ).toBe(true);
      } else {
        blocked++;
        expect(outcome.code, `轮 ${i}：失败码`).toBe("not_found");
        // 先藏后买：不扣费、无解锁记录
        expect(unlockRow, `轮 ${i}：不得有解锁记录`).toBeUndefined();
        expect(spendRow, `轮 ${i}：不得扣款`).toBeUndefined();
      }
    }
    // 两种结果都应出现过（窗口被真实锤到）；即使极端调度全部一边倒，总数也必须闭合
    expect(purchased + blocked).toBe(15);

    // 余额守恒：恰好 purchased 元被扣
    const after = await db()
      .select({ balance: pointAccounts.balance })
      .from(pointAccounts)
      .where(eq(pointAccounts.userId, DEMO.team))
      .then((r) => r[0]?.balance ?? 0);
    expect(before - after).toBe(purchased);
  });
});
