// @vitest-environment node
/**
 * applyPoints 的真实 MySQL 集成测试（临时库 + 演示夹具）。
 * 夹具账户：alice 150 / xiaoyi 20 / member 100 / team 50（各一条 opening 台账）。
 */
import { eq, sql } from "drizzle-orm";
import { DEMO, getWebDb, pointAccounts, pointLedger } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setModuleEnabled } from "@/modules/kernel/state";
import { registerModule } from "@/modules/kernel/registry";
import { defineModule } from "@/modules/kernel/types";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { applyPoints, applyPointsInTx, builtinChannel, resolveChannelOrThrow } from "./apply";
import {
  IdempotencyConflictError,
  InsufficientPointsError,
  InvalidDeltaError,
  PointsOverflowError,
  UnregisteredChannelError,
} from "./errors";

let tdb: TempDb;
const db = () => getWebDb();
const account = async (userId: number) =>
  (await db().select().from(pointAccounts).where(eq(pointAccounts.userId, userId)))[0];
const ledgerOf = (userId: number) =>
  db().select().from(pointLedger).where(eq(pointLedger.userId, userId));
let seq = 0;
const key = (p = "t") => `${p}:${++seq}:${Math.random().toString(36).slice(2)}`;
const noEmit = { emitter: async () => {} };

// 模块声明的渠道（M7 的 earn.post 等）：注册在封板之前，由 module_state 控制启停
registerModule(
  defineModule({
    id: "test-rewards",
    description: "测试：声明奖励渠道",
    pointChannels: [
      { key: "earn.post", direction: "earn", label: "发帖奖励", dailyCap: true },
      { key: "spend.shop", direction: "spend", label: "商城" },
      { key: "adjust.admin", direction: "adjust", label: "手工调整" },
    ],
  }),
);

describe.skipIf(skipDb)("applyPoints · 真实 MySQL", () => {
  beforeAll(async () => {
    tdb = await setupTempDb();
  });
  afterAll(async () => {
    await tdb?.teardown();
  });

  describe("渠道与参数校验", () => {
    it("未注册渠道拒绝，且不留任何痕迹", async () => {
      const before = (await ledgerOf(DEMO.alice)).length;
      await expect(
        applyPoints(
          { userId: DEMO.alice, channel: "earn.typo", delta: 5, idempotencyKey: key() },
          noEmit,
        ),
      ).rejects.toThrow(UnregisteredChannelError);
      expect((await ledgerOf(DEMO.alice)).length).toBe(before);
    });

    it("内置渠道可用：earn.gate_sale 加分、spend.gate_unlock 扣分", async () => {
      const a = await applyPoints(
        { userId: DEMO.team, channel: "earn.gate_sale", delta: 5, idempotencyKey: key() },
        noEmit,
      );
      expect(a).toMatchObject({ applied: true, balanceAfter: 55 });
      const b = await applyPoints(
        { userId: DEMO.team, channel: "spend.gate_unlock", delta: -5, idempotencyKey: key() },
        noEmit,
      );
      expect(b.balanceAfter).toBe(50);
    });

    it("builtinChannel：同步取内置渠道；非内置抛未注册", () => {
      expect(builtinChannel("spend.gate_unlock")).toMatchObject({ direction: "spend" });
      expect(builtinChannel("earn.gate_sale")).toMatchObject({ direction: "earn" });
      expect(() => builtinChannel("earn.post")).toThrow(UnregisteredChannelError);
    });

    it("delta 必须是非零整数，符号与渠道方向一致；adjust 双向", async () => {
      const bad = (channel: string, delta: number) =>
        applyPoints({ userId: DEMO.team, channel, delta, idempotencyKey: key() }, noEmit);
      await expect(bad("earn.post", 0)).rejects.toThrow(InvalidDeltaError);
      await expect(bad("earn.post", 1.5)).rejects.toThrow(InvalidDeltaError);
      await expect(bad("earn.post", Number.NaN)).rejects.toThrow(InvalidDeltaError);
      await expect(bad("earn.post", -3)).rejects.toThrow(/必须为正/);
      await expect(bad("spend.shop", 3)).rejects.toThrow(/必须为负/);
      await expect(bad("adjust.admin", 3)).resolves.toMatchObject({ applied: true });
      await expect(bad("adjust.admin", -3)).resolves.toMatchObject({ applied: true });
      await expect(
        applyPoints(
          { userId: DEMO.team, channel: "earn.post", delta: 1, idempotencyKey: "" },
          noEmit,
        ),
      ).rejects.toThrow(/幂等键/);
    });

    it("模块声明的渠道随模块启停：停用即拒绝，重新启用即恢复", async () => {
      const req = () => ({
        userId: DEMO.team,
        channel: "earn.post",
        delta: 1,
        idempotencyKey: key(),
      });
      await expect(applyPoints(req(), noEmit)).resolves.toMatchObject({ applied: true });
      await setModuleEnabled("test-rewards", false);
      await expect(applyPoints(req(), noEmit)).rejects.toThrow(UnregisteredChannelError);
      // 内置渠道不受模块启停影响
      await expect(
        applyPoints(
          { userId: DEMO.team, channel: "earn.gate_sale", delta: 1, idempotencyKey: key() },
          noEmit,
        ),
      ).resolves.toMatchObject({ applied: true });
      await setModuleEnabled("test-rewards", true);
      await expect(applyPoints(req(), noEmit)).resolves.toMatchObject({ applied: true });
    });
  });

  describe("记账语义", () => {
    it("首次记账自动建账户；台账字段完整；累计收支分别累加", async () => {
      expect(await account(99001)).toBeUndefined();
      await applyPoints(
        {
          userId: 99001,
          channel: "earn.post",
          delta: 30,
          idempotencyKey: key(),
          ref: { type: "thread", id: 77 },
          note: "发帖奖励",
        },
        noEmit,
      );
      await applyPoints(
        { userId: 99001, channel: "spend.shop", delta: -12, idempotencyKey: key() },
        noEmit,
      );
      expect(await account(99001)).toMatchObject({
        balance: 18,
        lifetimeEarned: 30,
        lifetimeSpent: 12,
      });
      const rows = await ledgerOf(99001);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        delta: 30,
        balanceAfter: 30,
        channel: "earn.post",
        refType: "thread",
        refId: 77,
        note: "发帖奖励",
      });
      expect(rows[1]).toMatchObject({ delta: -12, balanceAfter: 18, refType: null, note: "" });
    });

    it("余额恰好等于支出额允许（归零）；多 1 点即拒绝，且拒绝时余额与台账不变", async () => {
      await applyPoints(
        { userId: 99002, channel: "earn.post", delta: 10, idempotencyKey: key() },
        noEmit,
      );
      await expect(
        applyPoints(
          { userId: 99002, channel: "spend.shop", delta: -11, idempotencyKey: key() },
          noEmit,
        ),
      ).rejects.toThrow(InsufficientPointsError);
      expect(await account(99002)).toMatchObject({ balance: 10 });
      expect(await ledgerOf(99002)).toHaveLength(1);
      await applyPoints(
        { userId: 99002, channel: "spend.shop", delta: -10, idempotencyKey: key() },
        noEmit,
      );
      expect(await account(99002)).toMatchObject({ balance: 0 });
    });

    it("没有账户的用户支出：不足，且不留下账户之外的任何记录", async () => {
      await expect(
        applyPoints(
          { userId: 99003, channel: "spend.shop", delta: -1, idempotencyKey: key() },
          noEmit,
        ),
      ).rejects.toThrow(InsufficientPointsError);
      expect(await ledgerOf(99003)).toHaveLength(0);
    });
  });

  describe("数值边界（复查 B2）", () => {
    const MAX_BALANCE = 4_294_967_295; // point_accounts.balance 是 INT UNSIGNED
    const MAX_DELTA = 2_147_483_647; // point_ledger.delta 是 INT

    it("余额会超过列上限：抛类型化的 PointsOverflowError（不是 MySQL 1264 原始错误），整体回滚；恰好到顶允许", async () => {
      const channel = await resolveChannelOrThrow("adjust.admin");
      const ROLLBACK = new Error("rollback");
      // 在事务里造数据并最后回滚：共享夹具的「余额 = 台账之和」对账不受影响
      await expect(
        db().transaction(async (tx) => {
          await tx
            .update(pointAccounts)
            .set({ balance: MAX_BALANCE - 3 })
            .where(eq(pointAccounts.userId, DEMO.xiaoyi));
          const req = (delta: number, p: string) => ({
            userId: DEMO.xiaoyi,
            channel: "adjust.admin",
            delta,
            idempotencyKey: key(p),
            note: "边界",
          });
          await expect(applyPointsInTx(tx, req(10, "ovf"), channel)).rejects.toBeInstanceOf(
            PointsOverflowError,
          );
          const [still] = await tx
            .select()
            .from(pointAccounts)
            .where(eq(pointAccounts.userId, DEMO.xiaoyi));
          expect(still?.balance).toBe(MAX_BALANCE - 3); // 被拒绝的一笔没有改动余额
          const ok = await applyPointsInTx(tx, req(3, "max"), channel);
          expect(ok.balanceAfter).toBe(MAX_BALANCE);
          throw ROLLBACK;
        }),
      ).rejects.toBe(ROLLBACK);
    });

    it("单笔 delta 超过台账列上限：InvalidDeltaError，不碰数据库", async () => {
      await expect(
        applyPoints(
          {
            userId: DEMO.alice,
            channel: "adjust.admin",
            delta: MAX_DELTA + 1,
            idempotencyKey: key("big"),
            note: "太大",
          },
          noEmit,
        ),
      ).rejects.toBeInstanceOf(InvalidDeltaError);
      await expect(
        applyPoints(
          {
            userId: DEMO.alice,
            channel: "adjust.admin",
            delta: -(MAX_DELTA + 1),
            idempotencyKey: key("bigneg"),
            note: "太小",
          },
          noEmit,
        ),
      ).rejects.toBeInstanceOf(InvalidDeltaError);
    });
  });

  describe("幂等", () => {
    it("同一幂等键重放：返回既有结果，不重复记账，不重复派发事件", async () => {
      const emitter = vi.fn(async () => {});
      const k = key("replay");
      const first = await applyPoints(
        { userId: 99004, channel: "earn.post", delta: 8, idempotencyKey: k },
        { emitter },
      );
      const again = await applyPoints(
        { userId: 99004, channel: "earn.post", delta: 8, idempotencyKey: k },
        { emitter },
      );
      expect(first.applied).toBe(true);
      expect(again).toMatchObject({
        applied: false,
        ledgerId: first.ledgerId,
        balanceAfter: 8,
        event: null,
      });
      expect(await account(99004)).toMatchObject({ balance: 8 });
      expect(await ledgerOf(99004)).toHaveLength(1);
      expect(emitter).toHaveBeenCalledTimes(1);
    });

    it("同一幂等键被用于不同用户/渠道/金额：报冲突而不是静默忽略", async () => {
      const k = key("conflict");
      await applyPoints(
        { userId: 99005, channel: "earn.post", delta: 8, idempotencyKey: k },
        noEmit,
      );
      for (const other of [
        { userId: 99006, channel: "earn.post", delta: 8 },
        { userId: 99005, channel: "adjust.admin", delta: 8 },
        { userId: 99005, channel: "earn.post", delta: 9 },
      ]) {
        await expect(applyPoints({ ...other, idempotencyKey: k }, noEmit)).rejects.toThrow(
          IdempotencyConflictError,
        );
      }
      expect(await account(99005)).toMatchObject({ balance: 8 });
    });

    it("并发重放同一幂等键 10 次：恰有一次真正记账", async () => {
      const k = key("race");
      const rs = await Promise.all(
        Array.from({ length: 10 }, () =>
          applyPoints({ userId: 99007, channel: "earn.post", delta: 5, idempotencyKey: k }, noEmit),
        ),
      );
      expect(rs.filter((r) => r.applied)).toHaveLength(1);
      expect(new Set(rs.map((r) => r.ledgerId)).size).toBe(1);
      expect(await account(99007)).toMatchObject({ balance: 5 });
      expect(await ledgerOf(99007)).toHaveLength(1);
    });
  });

  describe("并发与不变量", () => {
    it("余额 100、并发 20 笔各支出 10：恰 10 笔成功，余额归零且永不为负", async () => {
      await applyPoints(
        { userId: 99008, channel: "earn.post", delta: 100, idempotencyKey: key() },
        noEmit,
      );
      const rs = await Promise.allSettled(
        Array.from({ length: 20 }, () =>
          applyPoints(
            { userId: 99008, channel: "spend.shop", delta: -10, idempotencyKey: key() },
            noEmit,
          ),
        ),
      );
      expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(10);
      const rejected = rs.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(rejected).toHaveLength(10);
      expect(rejected.every((r) => r.reason instanceof InsufficientPointsError)).toBe(true);
      expect(await account(99008)).toMatchObject({ balance: 0, lifetimeSpent: 100 });
    });

    it("随机并发混合收支后：每个账户 Σ台账 = 余额，且 balance_after 序列自洽", async () => {
      const users = [99010, 99011, 99012];
      let s = 7;
      const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
      await Promise.allSettled(
        Array.from({ length: 60 }, () => {
          const userId = users[Math.floor(rnd() * users.length)]!;
          const earn = rnd() < 0.55;
          const amount = 1 + Math.floor(rnd() * 20);
          return applyPoints(
            {
              userId,
              channel: earn ? "earn.post" : "spend.shop",
              delta: earn ? amount : -amount,
              idempotencyKey: key("rand"),
            },
            noEmit,
          );
        }),
      );
      for (const u of users) {
        const acc = await account(u);
        const rows = await ledgerOf(u);
        const sum = rows.reduce((a, r) => a + r.delta, 0);
        expect(acc?.balance ?? 0, `user ${u}`).toBe(sum);
        expect(sum).toBeGreaterThanOrEqual(0);
        // 按台账 id 顺序回放，balance_after 必须等于累计值
        let running = 0;
        for (const r of [...rows].sort((x, y) => x.id - y.id)) {
          running += r.delta;
          expect(r.balanceAfter).toBe(running);
        }
      }
    });

    it("全库对账：每个账户余额 = 其台账之和（含夹具的 opening 分录）", async () => {
      const res = await db().execute(sql`
        SELECT COUNT(*) AS n FROM point_accounts a
        WHERE a.balance <> (SELECT COALESCE(SUM(delta), 0) FROM point_ledger l WHERE l.user_id = a.user_id)`);
      expect(Number((res as unknown as [{ n: number }[]])[0][0]?.n)).toBe(0);
    });
  });

  describe("嵌入事务", () => {
    it("applyPointsInTx 不自己提交、不派发事件；调用方回滚则记账一并消失", async () => {
      await applyPoints(
        { userId: 99020, channel: "earn.post", delta: 40, idempotencyKey: key() },
        noEmit,
      );
      const k = key("rollback");
      let event: unknown;
      // 渠道在事务外解析好再传入（事务内不再借第二条连接，见 apply.ts）
      const channel = await resolveChannelOrThrow("spend.shop");
      await expect(
        db().transaction(async (tx) => {
          const r = await applyPointsInTx(
            tx,
            { userId: 99020, channel: "spend.shop", delta: -15, idempotencyKey: k },
            channel,
          );
          event = r.event;
          throw new Error("业务后续步骤失败，整体回滚");
        }),
      ).rejects.toThrow("整体回滚");
      expect(event).toEqual({ userId: 99020, channel: "spend.shop", delta: -15 }); // 事件交还给调用方，但没有被派发
      expect(await account(99020)).toMatchObject({ balance: 40 });
      expect(await ledgerOf(99020)).toHaveLength(1);
      // 回滚后同一幂等键可正常重新使用
      await expect(
        applyPoints(
          { userId: 99020, channel: "spend.shop", delta: -15, idempotencyKey: k },
          noEmit,
        ),
      ).resolves.toMatchObject({ applied: true, balanceAfter: 25 });
    });
  });

  describe("事件", () => {
    it("提交后派发 points.changed 一次；派发失败不影响已提交的记账", async () => {
      const emitter = vi.fn(async () => {});
      await applyPoints(
        { userId: 99030, channel: "earn.post", delta: 3, idempotencyKey: key() },
        { emitter },
      );
      expect(emitter).toHaveBeenCalledWith("points.changed", {
        userId: 99030,
        channel: "earn.post",
        delta: 3,
      });

      const boom = vi.fn(async () => {
        throw new Error("总线故障");
      });
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const r = await applyPoints(
        { userId: 99030, channel: "earn.post", delta: 4, idempotencyKey: key() },
        { emitter: boom },
      );
      expect(r).toMatchObject({ applied: true, balanceAfter: 7 });
      expect(await account(99030)).toMatchObject({ balance: 7 });
      spy.mockRestore();
    });
  });
});
