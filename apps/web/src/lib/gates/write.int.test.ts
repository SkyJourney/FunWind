// @vitest-environment node
/**
 * 门控写入器的真实 MySQL 集成测试（M6.1）。
 * 重点：① 落库结果正确且不泄露隐藏文本；② 失败时一行都不写；③ 删除门控与购买并发时，不会出现
 * "门控没了、钱却扣了"；④ updated_at 只在内容真的变了时推进。
 */
import { eq, sql } from "drizzle-orm";
import {
  DEMO,
  attachments,
  files,
  gateUnlocks,
  getWebDb,
  pointAccounts,
  postGates,
} from "@funwind/db";
import type { GateDraft } from "@funwind/content";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSubject } from "@/lib/authz/subject";
import type { Subject } from "@/lib/authz/types";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { unlockGate } from "./unlock";
import { applyGateDrafts, type GatePermissions } from "./write";

const POST = 900102; // 夹具里没有门控的帖子（作者 alice），普通会员可见
/** 并发用例用的帖子：必须是 member 能看见的（900105 在受限版块 904，会员买不到，用它会让并发测试空转） */
const RACE_POST = 900102;
const ALL: GatePermissions = { points: true, reply: true };
const NONE: GatePermissions = { points: false, reply: false };
const SECRET = "WRITE-TEST-SECRET-⑦";

let tdb: TempDb;
let member: Subject;
const db = () => getWebDb();
const draft = (key: string, over: Partial<GateDraft> = {}): GateDraft => ({
  key,
  seq: 1,
  conditions: [{ type: "points", price: 10 }],
  matchMode: "all",
  hiddenMd: "隐藏正文",
  ...over,
});
const save = (drafts: GateDraft[], perms: GatePermissions = ALL, postId = POST) =>
  db().transaction((tx) => applyGateDrafts(tx, postId, drafts, perms));
const rows = (postId = POST) => db().select().from(postGates).where(eq(postGates.postId, postId));
const byKey = async (k: string, postId = POST) => (await rows(postId)).find((r) => r.gateKey === k);

describe.skipIf(skipDb)("门控写入器 · 真实 MySQL", () => {
  beforeAll(async () => {
    tdb = await setupTempDb();
    member = await loadSubject(DEMO.member);
  });
  afterAll(async () => {
    await tdb?.teardown();
  });

  it("新增：落库条件 / 匹配模式 / 隐藏正文，返回 hasGate；结果里不含隐藏文本", async () => {
    const r = await save([
      draft("a1", { hiddenMd: SECRET }),
      draft("a2", { conditions: [{ type: "reply" }], matchMode: "any", seq: 2 }),
    ]);
    expect(r).toEqual({ ok: true, hasGate: true, gateCount: 2 });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    const a1 = await byKey("a1");
    expect(a1).toMatchObject({
      conditions: [{ type: "points", price: 10 }],
      matchMode: "all",
      hiddenMd: SECRET,
    });
    expect((await byKey("a2"))?.conditions).toEqual([{ type: "reply" }]);
  });

  it("失败时一行都不写：缺权限的新门控与合法的更新放在一起，整体拒绝，已有门控原样", async () => {
    const before = await rows();
    const r = await save(
      [draft("a1", { hiddenMd: "改了" }), draft("a3", { conditions: [{ type: "reply" }] })],
      { points: true, reply: false },
    );
    expect(r).toMatchObject({ ok: false, error: { code: "gate_permission", gateKey: "a3" } });
    const after = await rows();
    expect(after.map((x) => [x.gateKey, x.hiddenMd])).toEqual(
      before.map((x) => [x.gateKey, x.hiddenMd]),
    );
    expect(after.some((x) => x.gateKey === "a3")).toBe(false);
  });

  it("没有权限也能编辑未改条件的既有门控的隐藏正文；updated_at 只在内容真的变了时推进", async () => {
    await db().execute(
      sql`UPDATE post_gates SET updated_at = '2026-01-01 00:00:00' WHERE post_id = ${POST}`,
    );
    // 内容、条件、匹配模式都没变 → 不推进
    await save(
      [
        draft("a1", { hiddenMd: SECRET }),
        draft("a2", { conditions: [{ type: "reply" }], matchMode: "any", seq: 2 }),
      ],
      NONE,
    );
    expect((await byKey("a1"))?.updatedAt).toBe("2026-01-01 00:00:00");
    expect((await byKey("a2"))?.updatedAt).toBe("2026-01-01 00:00:00");
    // 只改 a1 的隐藏正文 → 只有 a1 推进
    await save(
      [
        draft("a1", { hiddenMd: `${SECRET} 改` }),
        draft("a2", { conditions: [{ type: "reply" }], matchMode: "any", seq: 2 }),
      ],
      NONE,
    );
    expect((await byKey("a1"))?.updatedAt).not.toBe("2026-01-01 00:00:00");
    expect((await byKey("a1"))?.hiddenMd).toBe(`${SECRET} 改`);
    expect((await byKey("a2"))?.updatedAt).toBe("2026-01-01 00:00:00");
    // 改价格（条件变了）→ 推进
    await db().execute(
      sql`UPDATE post_gates SET updated_at = '2026-01-01 00:00:00' WHERE post_id = ${POST}`,
    );
    await save(
      [
        draft("a1", { hiddenMd: `${SECRET} 改`, conditions: [{ type: "points", price: 11 }] }),
        draft("a2", { conditions: [{ type: "reply" }], matchMode: "any", seq: 2 }),
      ],
      ALL,
    );
    expect((await byKey("a1"))?.updatedAt).not.toBe("2026-01-01 00:00:00");
  });

  it("删除：没有解锁记录时可删，hasGate 随之变化", async () => {
    expect(
      await save([
        draft("a1", { conditions: [{ type: "points", price: 11 }], hiddenMd: `${SECRET} 改` }),
      ]),
    ).toEqual({ ok: true, hasGate: true, gateCount: 1 });
    expect(await byKey("a2")).toBeUndefined();
    expect(await save([])).toEqual({ ok: true, hasGate: false, gateCount: 0 });
    expect(await rows()).toHaveLength(0);
  });

  describe("已有解锁记录", () => {
    const P = 900101;
    let gateId: number;
    beforeAll(async () => {
      await db()
        .insert(postGates)
        .values({
          postId: P,
          gateKey: "s1",
          conditions: [{ type: "points", price: 10 }],
          matchMode: "all",
          hiddenMd: "卖点",
          createdAt: "2026-10-20 00:00:00",
          updatedAt: "2026-10-20 00:00:00",
        });
      gateId = (await byKey("s1", P))!.id;
      await db().insert(gateUnlocks).values({
        gateId,
        userId: DEMO.member,
        pricePaid: 10,
        authorIncome: 10,
        unlockedAt: "2026-10-20 00:00:00",
      });
    });

    it("不可删除；对照：同一帖里没人买的另一个门控可以删", async () => {
      await db()
        .insert(postGates)
        .values({
          postId: P,
          gateKey: "s2",
          conditions: [{ type: "reply" }],
          matchMode: "all",
          hiddenMd: "x",
          createdAt: "2026-10-20 00:00:00",
          updatedAt: "2026-10-20 00:00:00",
        });
      expect(await save([draft("s1")], ALL, P)).toMatchObject({ ok: true, gateCount: 1 }); // s2 被删，s1 保留
      expect(await save([], ALL, P)).toMatchObject({
        ok: false,
        error: { code: "gate_has_unlocks", gateKey: "s1" },
      });
      expect(await byKey("s1", P)).toBeDefined();
    });

    it("可以改价格和隐藏正文；不可换解锁方式", async () => {
      expect(
        await save(
          [draft("s1", { conditions: [{ type: "points", price: 25 }], hiddenMd: "新卖点" })],
          ALL,
          P,
        ),
      ).toMatchObject({ ok: true });
      expect(await byKey("s1", P)).toMatchObject({
        conditions: [{ type: "points", price: 25 }],
        hiddenMd: "新卖点",
      });
      expect(await save([draft("s1", { conditions: [{ type: "reply" }] })], ALL, P)).toMatchObject({
        ok: false,
        error: { code: "gate_conditions_locked" },
      });
      expect((await byKey("s1", P))?.conditions).toEqual([{ type: "points", price: 25 }]);
    });
  });

  it("名下挂着附件的门控不可删除（不得让附件悄悄变公开）", async () => {
    const P = 900103;
    await save([draft("f1")], ALL, P);
    const gateId = (await byKey("f1", P))!.id;
    const [f] = (await db()
      .insert(files)
      .values({
        sha256: "e".repeat(64),
        storageKey: `ee/ee/${"e".repeat(64)}.zip`,
        sizeBytes: 1,
        mime: "application/zip",
        createdAt: "2026-10-20 00:00:00",
      })) as unknown as [{ insertId: number }];
    await db()
      .insert(attachments)
      .values({
        postId: P,
        gateId,
        fileId: Number(f.insertId),
        uploaderId: DEMO.alice,
        originalName: "x.zip",
        createdAt: "2026-10-20 00:00:00",
      });
    expect(await save([], ALL, P)).toMatchObject({
      ok: false,
      error: { code: "gate_has_attachments", gateKey: "f1" },
    });
    expect(await byKey("f1", P)).toBeDefined();
    // 对照：附件改挂到别处（gate_id 置空）后可以删
    await db().update(attachments).set({ gateId: null }).where(eq(attachments.gateId, gateId));
    expect(await save([], ALL, P)).toMatchObject({ ok: true, hasGate: false });
  });

  it("对照（防止并发用例空转）：同一个帖子上、没有并发删除时，买家确实能买到门控", async () => {
    const P = RACE_POST;
    await db().delete(postGates).where(eq(postGates.postId, P));
    await db().delete(gateUnlocks).where(eq(gateUnlocks.userId, DEMO.member));
    await db()
      .insert(postGates)
      .values({
        postId: P,
        gateKey: "c1",
        conditions: [{ type: "points", price: 5 }],
        matchMode: "all",
        hiddenMd: "对照",
        createdAt: "2026-10-20 00:00:00",
        updatedAt: "2026-10-20 00:00:00",
      });
    const gid = (await byKey("c1", P))!.id;
    expect(await unlockGate(member, gid)).toMatchObject({ ok: true, pricePaid: 5 });
    await db().delete(postGates).where(eq(postGates.postId, P));
    await db().delete(gateUnlocks).where(eq(gateUnlocks.userId, DEMO.member));
  });

  it("确定性交错：删除门控读完现状后、写入前，买家想买——必须被门控行的排他锁挡住，买家看到的是门控已不存在，钱不动", async () => {
    const P = RACE_POST;
    await db().delete(postGates).where(eq(postGates.postId, P));
    await db().delete(gateUnlocks).where(eq(gateUnlocks.userId, DEMO.member));
    await db()
      .insert(postGates)
      .values({
        postId: P,
        gateKey: "x1",
        conditions: [{ type: "points", price: 5 }],
        matchMode: "all",
        hiddenMd: "交错",
        createdAt: "2026-10-20 00:00:00",
        updatedAt: "2026-10-20 00:00:00",
      });
    const gid = (await byKey("x1", P))!.id;
    const balance = async () =>
      (
        await db()
          .select({ b: pointAccounts.balance })
          .from(pointAccounts)
          .where(eq(pointAccounts.userId, DEMO.member))
      )[0]!.b;
    const before = await balance();

    let buy!: ReturnType<typeof unlockGate>;
    const del = db().transaction((tx) =>
      applyGateDrafts(tx, P, [], ALL, {
        afterRead: async () => {
          // 此刻删除方已读到"没有解锁记录"。买家现在发起购买；有锁则它会阻塞到删除提交之后
          buy = unlockGate(member, gid);
          await new Promise((r) => setTimeout(r, 400));
        },
      }),
    );
    const [delRes, buyRes] = [await del, await buy];
    expect(delRes).toMatchObject({ ok: true, hasGate: false });
    expect(buyRes).toMatchObject({ ok: false, code: "not_found" });
    expect(await balance()).toBe(before);
    expect((await db().select().from(gateUnlocks).where(eq(gateUnlocks.gateId, gid))).length).toBe(
      0,
    );
  });

  it("并发：删除门控与购买同时发生——要么买到（删除被拒），要么门控没了且没扣钱，绝不会「钱扣了、门控没了」", async () => {
    const P = RACE_POST;
    for (let round = 0; round < 6; round++) {
      await db().delete(postGates).where(eq(postGates.postId, P));
      await db().delete(gateUnlocks).where(eq(gateUnlocks.userId, DEMO.member));
      await db()
        .insert(postGates)
        .values({
          postId: P,
          gateKey: `r${round}`,
          conditions: [{ type: "points", price: 5 }],
          matchMode: "all",
          hiddenMd: "并发",
          createdAt: "2026-10-20 00:00:00",
          updatedAt: "2026-10-20 00:00:00",
        });
      const gid = (await byKey(`r${round}`, P))!.id;
      const [{ balance: before }] = await db()
        .select({ balance: pointAccounts.balance })
        .from(pointAccounts)
        .where(eq(pointAccounts.userId, DEMO.member));
      const [del, buy] = await Promise.all([save([], ALL, P), unlockGate(member, gid)]);
      const after = (
        await db()
          .select({ balance: pointAccounts.balance })
          .from(pointAccounts)
          .where(eq(pointAccounts.userId, DEMO.member))
      )[0]!.balance;
      const gateStillThere = (await rows(P)).length === 1;
      const unlockRows = (await db().select().from(gateUnlocks).where(eq(gateUnlocks.gateId, gid)))
        .length;
      if (buy.ok) {
        // 买成功：门控必须还在、扣了钱、有解锁记录；删除被拒
        expect(gateStillThere, `第 ${round} 轮`).toBe(true);
        expect(after, `第 ${round} 轮`).toBe(before - 5);
        expect(unlockRows).toBe(1);
        expect(del.ok).toBe(false);
      } else {
        // 没买成：钱不能动，也没有解锁记录；此时门控应已被删掉
        expect(after, `第 ${round} 轮`).toBe(before);
        expect(unlockRows).toBe(0);
        expect(del.ok).toBe(true);
        expect(gateStillThere).toBe(false);
      }
    }
  });
});
