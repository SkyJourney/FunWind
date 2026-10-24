// @vitest-environment node
/**
 * unlockGate 的真实 MySQL 集成测试（临时库 + 演示夹具）。
 * 夹具：门控 9001（首帖 900104，作者 alice，积分 10）；余额 alice 150 / xiaoyi 20 / member 100 / team 50；
 * member 已购买 9001；xiaoyi 是帖 900102 的作者。
 */
import { eq, sql } from "drizzle-orm";
import {
  DEMO,
  gateUnlocks,
  getWebDb,
  pointAccounts,
  pointLedger,
  postGates,
  siteSettings,
  threads,
  users,
} from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadSubject } from "@/lib/authz/subject";
import type { Subject } from "@/lib/authz/types";
import { applyPoints } from "@/lib/points/apply";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { loadGateViews } from "./service";
import { feeOf, getGateFeeRate, unlockGate } from "./unlock";

let tdb: TempDb;
let alice: Subject,
  xiaoyi: Subject,
  member: Subject,
  team: Subject,
  banned: Subject,
  admin: Subject,
  guest: Subject;
const db = () => getWebDb();
const emitted: { name: string; payload: unknown }[] = [];
const deps = {
  emitter: async (name: string, payload: unknown) => void emitted.push({ name, payload }),
};
const run = (s: Subject, gateId: number) => unlockGate(s, gateId, deps as never);

let seq = 0;
/** 在指定帖上造一个门控；返回 gate id */
async function mkGate(postId: number, conditions: unknown[], matchMode: "all" | "any" = "all") {
  const [{ insertId }] = (await db()
    .insert(postGates)
    .values({
      postId,
      gateKey: `t${++seq}`,
      conditions,
      matchMode,
      hiddenMd: "测试隐藏内容",
      createdAt: "2026-10-20 00:00:00",
      updatedAt: "2026-10-20 00:00:00",
    })) as unknown as [{ insertId: number }];
  return Number(insertId);
}
const balance = async (u: number) =>
  (await db().select().from(pointAccounts).where(eq(pointAccounts.userId, u)))[0]?.balance;
const ledger = (u: number) => db().select().from(pointLedger).where(eq(pointLedger.userId, u));
const unlockRow = async (g: number, u: number) =>
  (
    await db()
      .select()
      .from(gateUnlocks)
      .where(eq(gateUnlocks.gateId, g))
      .then((r) => r.filter((x) => x.userId === u))
  )[0];
const unlockCount = async (g: number) =>
  (await db().select().from(postGates).where(eq(postGates.id, g)))[0]?.unlockCount;
const setFee = (rate: unknown) =>
  db()
    .insert(siteSettings)
    .values({ key: "points.gate_fee_rate", value: { rate }, updatedAt: sql`NOW()` })
    .onDuplicateKeyUpdate({ set: { value: { rate } } });

describe("手续费纯函数", () => {
  it("feeOf：floor(价格×费率)；费率 0 无手续费", () => {
    expect(feeOf(15, 0.1)).toBe(1);
    expect(feeOf(9, 0.1)).toBe(0);
    expect(feeOf(100, 0.25)).toBe(25);
    expect(feeOf(100, 0)).toBe(0);
  });
});

describe.skipIf(skipDb)("unlockGate · 真实 MySQL", () => {
  beforeAll(async () => {
    tdb = await setupTempDb();
    [alice, xiaoyi, member, team, banned, admin, guest] = await Promise.all([
      loadSubject(DEMO.alice),
      loadSubject(DEMO.xiaoyi),
      loadSubject(DEMO.member),
      loadSubject(DEMO.team),
      loadSubject(DEMO.banned),
      loadSubject(DEMO.admin),
      loadSubject(null),
    ]);
  });
  afterAll(async () => {
    await tdb?.teardown();
  });

  describe("拒绝场景", () => {
    it("未登录 → login；门控不存在 → not_found", async () => {
      expect(await run(guest, DEMO.pointsGate)).toEqual({ ok: false, code: "login" });
      expect(await run(member, 424242)).toMatchObject({ ok: false, code: "not_found" });
    });

    it("作者、版主/admin → own_content（无需购买），不写任何记录", async () => {
      const before = (await ledger(DEMO.alice)).length;
      expect(await run(alice, DEMO.pointsGate)).toMatchObject({ ok: false, code: "own_content" });
      expect(await run(admin, DEMO.pointsGate)).toMatchObject({ ok: false, code: "own_content" });
      expect((await ledger(DEMO.alice)).length).toBe(before);
      expect(await unlockRow(DEMO.pointsGate, DEMO.alice)).toBeUndefined();
    });

    it("所在帖子对读者不可见 → not_found（知道门控 id 也买不到）", async () => {
      const g = await mkGate(900105, [{ type: "points", price: 5 }]); // 900105 在受限版块 904
      expect(await run(member, g)).toMatchObject({ ok: false, code: "not_found" });
      expect(await run(guest, g)).toMatchObject({ ok: false, code: "login" });
      expect(await balance(DEMO.member)).toBe(100);
      // 能读该版块的团队成员（非作者：作者是 team 自己）→ 作者本人无需购买
      expect(await run(team, g)).toMatchObject({ ok: false, code: "own_content" });
    });

    it("没有积分条件 / 价格非法 → unavailable", async () => {
      const onlyReply = await mkGate(900102, [{ type: "reply" }]);
      const badPrice = await mkGate(900102, [{ type: "points", price: -3 }]);
      const frac = await mkGate(900102, [{ type: "points", price: 1.5 }]);
      for (const g of [onlyReply, badPrice, frac]) {
        expect(await run(member, g), String(g)).toMatchObject({ ok: false, code: "unavailable" });
      }
      expect(await balance(DEMO.member)).toBe(100);
    });
  });

  describe("成功购买", () => {
    it("已购买者再点：alreadyUnlocked，不扣费不重复记账不派发事件", async () => {
      emitted.length = 0;
      const r = await run(member, DEMO.pointsGate);
      expect(r).toMatchObject({ ok: true, alreadyUnlocked: true, pricePaid: 10 });
      expect(await balance(DEMO.member)).toBe(100);
      expect(emitted).toEqual([]);
    });

    it("正常购买：读者 −10，作者 +10；解锁记录、台账引用、解锁计数、事件齐全", async () => {
      emitted.length = 0;
      const countBefore = (await unlockCount(DEMO.pointsGate)) ?? 0;
      const r = await run(xiaoyi, DEMO.pointsGate);
      expect(r).toMatchObject({ ok: true, alreadyUnlocked: false, pricePaid: 10 });
      expect(await balance(DEMO.xiaoyi)).toBe(10);
      expect(await balance(DEMO.alice)).toBe(160);

      const [spend] = (await ledger(DEMO.xiaoyi)).filter((l) => l.channel === "spend.gate_unlock");
      expect(spend).toMatchObject({
        delta: -10,
        idempotencyKey: `gate_unlock:${DEMO.pointsGate}:${DEMO.xiaoyi}`,
        refType: "gate",
        refId: DEMO.pointsGate,
      });
      const [sale] = (await ledger(DEMO.alice)).filter((l) => l.channel === "earn.gate_sale");
      expect(sale).toMatchObject({
        delta: 10,
        idempotencyKey: `gate_sale:${DEMO.pointsGate}:${DEMO.xiaoyi}`,
      });

      expect(await unlockRow(DEMO.pointsGate, DEMO.xiaoyi)).toMatchObject({
        pricePaid: 10,
        authorIncome: 10,
        ledgerId: spend!.id,
      });
      expect(await unlockCount(DEMO.pointsGate)).toBe(countBefore + 1);
      expect(emitted.map((e) => e.name)).toEqual([
        "points.changed",
        "points.changed",
        "gate.unlocked",
      ]);
      expect(emitted[2]!.payload).toEqual({
        gateId: DEMO.pointsGate,
        userId: DEMO.xiaoyi,
        authorId: DEMO.alice,
        price: 10,
      });

      // 购买后该读者的页面视图变为已解锁
      const views = await loadGateViews(xiaoyi, { id: 900004, forumId: 901 }, [
        { id: DEMO.gatePost, authorId: DEMO.alice, hasGate: true },
      ]);
      expect(views.get(DEMO.gatePost)?.get("a1")).toMatchObject({
        status: "open",
        reason: "unlocked",
        pricePaid: 10,
      });
    });

    it("再点一次：已解锁，余额不再变化", async () => {
      expect(await run(xiaoyi, DEMO.pointsGate)).toMatchObject({ ok: true, alreadyUnlocked: true });
      expect(await balance(DEMO.xiaoyi)).toBe(10);
      expect(await balance(DEMO.alice)).toBe(160);
    });

    it("余额恰好等于价格：成功并归零", async () => {
      const g = await mkGate(900101, [{ type: "points", price: 50 }]); // 作者 alice
      expect(await run(team, g)).toMatchObject({ ok: true, pricePaid: 50 });
      expect(await balance(DEMO.team)).toBe(0);
    });

    it("余额不足：insufficient；读者/作者余额、台账、解锁记录、解锁计数全部不变", async () => {
      const g = await mkGate(900101, [{ type: "points", price: 500 }]);
      const snap = async () => [
        await balance(DEMO.xiaoyi),
        await balance(DEMO.alice),
        (await ledger(DEMO.xiaoyi)).length,
        (await ledger(DEMO.alice)).length,
      ];
      const before = await snap();
      emitted.length = 0;
      expect(await run(xiaoyi, g)).toMatchObject({ ok: false, code: "insufficient" });
      expect(await snap()).toEqual(before);
      expect(await unlockRow(g, DEMO.xiaoyi)).toBeUndefined();
      expect(await unlockCount(g)).toBe(0);
      expect(emitted).toEqual([]);
    });

    it("没有积分账户的读者买付费内容：insufficient，且不留下空账户之外的痕迹", async () => {
      const g = await mkGate(900101, [{ type: "points", price: 5 }]);
      expect(await balance(DEMO.banned)).toBeUndefined();
      expect(await run(banned, g)).toMatchObject({ ok: false, code: "insufficient" });
      expect(await unlockRow(g, DEMO.banned)).toBeUndefined();
      expect(await ledger(DEMO.banned)).toHaveLength(0);
    });

    it("价格 0：只写解锁记录，不动台账、不建账户；重复点击只有一条", async () => {
      const g = await mkGate(900101, [{ type: "points", price: 0 }]);
      const rs = await Promise.all(Array.from({ length: 6 }, () => run(banned, g)));
      expect(rs.every((r) => r.ok)).toBe(true);
      expect(rs.filter((r) => r.ok && !r.alreadyUnlocked)).toHaveLength(1);
      expect(await unlockRow(g, DEMO.banned)).toMatchObject({
        pricePaid: 0,
        authorIncome: 0,
        ledgerId: null,
      });
      expect(await ledger(DEMO.banned)).toHaveLength(0);
      expect(await balance(DEMO.banned)).toBeUndefined();
      expect(await unlockCount(g)).toBe(1);
    });

    it("门控同时要求回复（all 模式）：可以先买，买后仍提示需回复", async () => {
      const g = await mkGate(900101, [{ type: "points", price: 1 }, { type: "reply" }], "all");
      expect(await run(member, g)).toMatchObject({ ok: true, alreadyUnlocked: false });
      const views = await loadGateViews(member, { id: 900001, forumId: 901 }, [
        { id: 900101, authorId: DEMO.alice, hasGate: true },
      ]);
      expect(views.get(900101)?.get(`t${seq}`)).toMatchObject({
        status: "locked",
        prompts: [{ kind: "reply" }],
      });
    });
  });

  describe("并发", () => {
    it("同一读者对同一门控并发点击 12 次：恰扣一次、恰一条解锁、台账恰两条", async () => {
      const g = await mkGate(900101, [{ type: "points", price: 5 }]);
      const aliceBefore = (await balance(DEMO.alice))!;
      const memberBefore = (await balance(DEMO.member))!;
      const rs = await Promise.all(Array.from({ length: 12 }, () => run(member, g)));
      expect(rs.every((r) => r.ok)).toBe(true);
      expect(rs.filter((r) => r.ok && !r.alreadyUnlocked)).toHaveLength(1);
      expect(await balance(DEMO.member)).toBe(memberBefore - 5);
      expect(await balance(DEMO.alice)).toBe(aliceBefore + 5);
      expect(
        (await ledger(DEMO.member)).filter(
          (l) => l.idempotencyKey === `gate_unlock:${g}:${DEMO.member}`,
        ),
      ).toHaveLength(1);
      expect(
        (await ledger(DEMO.alice)).filter(
          (l) => l.idempotencyKey === `gate_sale:${g}:${DEMO.member}`,
        ),
      ).toHaveLength(1);
      expect(await unlockCount(g)).toBe(1);
    });

    it("交叉购买不死锁：alice 买 xiaoyi 的、xiaoyi 买 alice 的，同时发起，10 轮全部成功", async () => {
      await applyPoints(
        {
          userId: DEMO.alice,
          channel: "earn.gate_sale",
          delta: 100,
          idempotencyKey: "seed:cross:a",
        },
        { emitter: async () => {} },
      );
      await applyPoints(
        {
          userId: DEMO.xiaoyi,
          channel: "earn.gate_sale",
          delta: 100,
          idempotencyKey: "seed:cross:x",
        },
        { emitter: async () => {} },
      );
      for (let i = 0; i < 10; i++) {
        const byAlice = await mkGate(900101, [{ type: "points", price: 2 }]); // alice 的帖
        const byXiaoyi = await mkGate(900102, [{ type: "points", price: 2 }]); // xiaoyi 的帖
        const [a, b] = await Promise.all([run(alice, byXiaoyi), run(xiaoyi, byAlice)]);
        expect(a, `round ${i} alice`).toMatchObject({ ok: true });
        expect(b, `round ${i} xiaoyi`).toMatchObject({ ok: true });
      }
    });

    it("多读者多作者随机并发购买后：全部不变量成立（Σ台账=余额、总额守恒、无负余额）", async () => {
      // 8 个额外读者，各 100 积分
      const readers = Array.from({ length: 8 }, (_, i) => 98001 + i);
      for (const id of readers) {
        await db()
          .insert(users)
          .values({
            id,
            username: `reader${id}`,
            usernameKey: `reader${id}`,
            createdAt: "2026-10-01 00:00:00",
          });
        await applyPoints(
          {
            userId: id,
            channel: "earn.gate_sale",
            delta: 100,
            idempotencyKey: `seed:reader:${id}`,
          },
          { emitter: async () => {} },
        );
      }
      const subjects = await Promise.all(readers.map((id) => loadSubject(id)));
      const gates = [
        ...(await Promise.all(
          [3, 4, 5, 6].map((p) => mkGate(900101, [{ type: "points", price: p }])),
        )),
        ...(await Promise.all(
          [2, 7, 9].map((p) => mkGate(900102, [{ type: "points", price: p }])),
        )),
      ];
      const all = [DEMO.alice, DEMO.xiaoyi, DEMO.member, DEMO.team, ...readers];
      const total = async () =>
        (await db().select().from(pointAccounts)).reduce((a, r) => a + r.balance, 0);
      const before = await total();

      const jobs = subjects.flatMap((s) => gates.map((g) => run(s, g)));
      const results = await Promise.allSettled(jobs);
      expect(results.filter((r) => r.status === "rejected")).toEqual([]); // 业务失败只会是 ok:false，绝不抛
      const failed = results.filter((r) => r.status === "fulfilled" && !r.value.ok);
      expect(failed).toEqual([]); // 每人余额 100，7 个门控总价 38，必然都够

      expect(await total()).toBe(before); // 手续费率 0：总额守恒
      for (const u of all) {
        const rows = await ledger(u);
        const sum = rows.reduce((a, r) => a + r.delta, 0);
        const bal = (await balance(u)) ?? 0;
        expect(bal, `user ${u}`).toBe(sum);
        expect(bal).toBeGreaterThanOrEqual(0);
      }
      for (const g of gates) expect(await unlockCount(g)).toBe(readers.length);
    });
  });

  describe("手续费与特殊作者", () => {
    it("费率 0.1、价格 15：手续费 1，作者收 14；解锁记录的 author_income 为 14", async () => {
      await setFee(0.1);
      const g = await mkGate(900101, [{ type: "points", price: 15 }]);
      const aliceBefore = (await balance(DEMO.alice))!;
      const memberBefore = (await balance(DEMO.member))!;
      expect(await run(member, g)).toMatchObject({ ok: true, pricePaid: 15 });
      expect(await balance(DEMO.member)).toBe(memberBefore - 15);
      expect(await balance(DEMO.alice)).toBe(aliceBefore + 14);
      expect(await unlockRow(g, DEMO.member)).toMatchObject({ pricePaid: 15, authorIncome: 14 });
    });

    it("非法费率（≥1、负数、非数字）一律按 0，不会吞掉作者收益", async () => {
      for (const bad of [1, 1.5, -0.2, "0.5", null]) {
        await setFee(bad);
        expect(await getGateFeeRate(), String(bad)).toBe(0);
      }
      await setFee(0);
    });

    it("作者账号已注销（历史孤儿作者）：读者照常扣费，收益销毁，不写作者台账", async () => {
      const g = await mkGate(900102, [{ type: "points", price: 4 }]); // xiaoyi 的帖
      await db().update(users).set({ state: "deleted" }).where(eq(users.id, DEMO.xiaoyi));
      const authorLedger = (await ledger(DEMO.xiaoyi)).length;
      const authorBal = await balance(DEMO.xiaoyi);
      const memberBefore = (await balance(DEMO.member))!;
      // 帖子作者已注销：读者仍可见该帖（版块公开）
      expect(await run(member, g)).toMatchObject({ ok: true, pricePaid: 4 });
      expect(await balance(DEMO.member)).toBe(memberBefore - 4);
      expect((await ledger(DEMO.xiaoyi)).length).toBe(authorLedger);
      expect(await balance(DEMO.xiaoyi)).toBe(authorBal);
      expect(await unlockRow(g, DEMO.member)).toMatchObject({ pricePaid: 4, authorIncome: 0 });
      await db().update(users).set({ state: "active" }).where(eq(users.id, DEMO.xiaoyi));
    });
  });

  describe("原子性与事件", () => {
    it("作者侧记账中途失败（幂等键冲突）：整个购买回滚——读者没被扣费、没有解锁记录", async () => {
      const g = await mkGate(900101, [{ type: "points", price: 6 }]);
      // 预埋一条同键但内容不同的作者台账，让第二步 earn.gate_sale 抛 IdempotencyConflictError
      await db()
        .insert(pointLedger)
        .values({
          userId: DEMO.alice,
          delta: 1,
          balanceAfter: 1,
          channel: "earn.gate_sale",
          idempotencyKey: `gate_sale:${g}:${DEMO.member}`,
          createdAt: sql`NOW()`,
        });
      const memberBefore = await balance(DEMO.member);
      const ledgerBefore = (await ledger(DEMO.member)).length;
      await expect(run(member, g)).rejects.toThrow(/幂等键冲突/);
      expect(await balance(DEMO.member)).toBe(memberBefore);
      expect((await ledger(DEMO.member)).length).toBe(ledgerBefore);
      expect(await unlockRow(g, DEMO.member)).toBeUndefined();
      expect(await unlockCount(g)).toBe(0);
    });

    it("事件派发失败不影响已提交的购买", async () => {
      const g = await mkGate(900101, [{ type: "points", price: 1 }]);
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const r = await unlockGate(member, g, {
        emitter: async () => {
          throw new Error("总线故障");
        },
      });
      spy.mockRestore();
      expect(r).toMatchObject({ ok: true, alreadyUnlocked: false });
      expect(await unlockRow(g, DEMO.member)).toBeDefined();
    });

    it("主题被移到读者读不到的版块后：not_found（购买入口同样过可见性）", async () => {
      const g = await mkGate(900101, [{ type: "points", price: 1 }]);
      await db()
        .update(threads)
        .set({ forumId: DEMO.restrictedForum })
        .where(eq(threads.id, 900001));
      expect(await run(await loadSubject(DEMO.xiaoyi), g)).toMatchObject({
        ok: false,
        code: "not_found",
      });
      await db().update(threads).set({ forumId: 901 }).where(eq(threads.id, 900001));
    });
  });
});
