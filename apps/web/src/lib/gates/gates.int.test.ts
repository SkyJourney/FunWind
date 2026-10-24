// @vitest-environment node
/**
 * 门控读取服务的真实 MySQL 集成测试（临时库 + 演示夹具）。
 * 夹具：主题 900004（版块 901，作者 alice）首帖 900104 含两个门控——
 *   a1 / id 9001：积分 10，demo_member 已购买（pricePaid 10）；a2 / id 9002：回复可见。
 * 核心断言：锁定的结果序列化后不含任何隐藏文本。
 */
import { eq, sql } from "drizzle-orm";
import { DEMO, gateUnlocks, getWebDb, posts, threads } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSubject } from "@/lib/authz/subject";
import type { Subject } from "@/lib/authz/types";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { getGateContent, loadGateViews } from "./service";
import type { GateView } from "./types";

const PAID_TEXT = "需要 10 积分才能解锁的隐藏正文";
const REPLY_TEXT = "回复本帖后才能看到这段内容";
const THREAD = { id: 900004, forumId: 901 };
const FIRST = [{ id: DEMO.gatePost, authorId: DEMO.alice, hasGate: true }];

let tdb: TempDb;
let guest: Subject, alice: Subject, member: Subject, xiaoyi: Subject, admin: Subject;

const views = async (s: Subject) => (await loadGateViews(s, THREAD, FIRST)).get(DEMO.gatePost)!;
const open = (v: GateView | null | undefined) => (v?.status === "open" ? v : null);

describe.skipIf(skipDb)("门控读取 · 真实 MySQL", () => {
  beforeAll(async () => {
    tdb = await setupTempDb();
    [guest, alice, member, xiaoyi, admin] = await Promise.all([
      loadSubject(null),
      loadSubject(DEMO.alice),
      loadSubject(DEMO.member),
      loadSubject(DEMO.xiaoyi),
      loadSubject(DEMO.admin),
    ]);
  });
  afterAll(async () => {
    await tdb?.teardown();
  });

  it("游客：两个门控都只给登录提示；序列化结果不含任何隐藏文本", async () => {
    const v = await views(guest);
    expect(v.get("a1")).toMatchObject({ status: "locked", prompts: [{ kind: "login" }] });
    expect(v.get("a2")).toMatchObject({ status: "locked", prompts: [{ kind: "login" }] });
    const dump = JSON.stringify([...v]);
    expect(dump).not.toContain(PAID_TEXT);
    expect(dump).not.toContain(REPLY_TEXT);
    expect(dump).not.toContain("隐藏正文");
  });

  it("作者：两个门控都开放；付费门控带购买人数与累计收益", async () => {
    const v = await views(alice);
    const paid = open(v.get("a1"));
    expect(paid).toMatchObject({ reason: "author", stats: { buyers: 1, income: 10 } });
    expect(paid?.contentMd).toContain(PAID_TEXT);
    expect(open(v.get("a2"))?.contentMd).toContain(REPLY_TEXT);
  });

  it("已购买的会员：付费门控开放并带购买记录；回复门控仍锁定（提示回复）", async () => {
    const v = await views(member);
    expect(open(v.get("a1"))).toMatchObject({
      reason: "unlocked",
      pricePaid: 10,
      unlockedAt: "2026-10-13 09:00:00",
    });
    expect(open(v.get("a1"))?.contentMd).toContain(PAID_TEXT);
    expect(v.get("a2")).toMatchObject({ status: "locked", prompts: [{ kind: "reply" }] });
    expect(JSON.stringify(v.get("a2"))).not.toContain(REPLY_TEXT);
  });

  it("未购买的会员：付费门控锁定，提示价格与自己的余额；锁定结果不含正文", async () => {
    const v = await views(xiaoyi);
    expect(v.get("a1")).toMatchObject({
      status: "locked",
      prompts: [{ kind: "points", price: 10, balance: 20 }],
    });
    expect(JSON.stringify([...v])).not.toContain(PAID_TEXT);
  });

  it("没有积分账户的用户余额按 0", async () => {
    const v = await views(await loadSubject(DEMO.banned));
    expect(v.get("a1")).toMatchObject({ prompts: [{ kind: "points", price: 10, balance: 0 }] });
  });

  it("admin（版主权限）：全部开放，标记为 moderator", async () => {
    const v = await views(admin);
    expect(open(v.get("a1"))?.reason).toBe("moderator");
    expect(open(v.get("a2"))?.reason).toBe("moderator");
  });

  it("回复可见：visible 回帖解锁；待审核/已隐藏/首帖本身不算", async () => {
    const db = getWebDb();
    const reply = (id: number, floor: number, state: "visible" | "pending" | "hidden") =>
      db.insert(posts).values({
        id,
        threadId: THREAD.id,
        floor,
        authorId: DEMO.xiaoyi,
        bodyMd: "回复",
        state,
        createdAt: "2026-10-14 10:00:00",
      });

    expect((await views(xiaoyi)).get("a2")?.status).toBe("locked");
    await reply(950001, 2, "pending");
    await reply(950002, 3, "hidden");
    expect((await views(xiaoyi)).get("a2")?.status).toBe("locked"); // 待审核、已隐藏都不算
    await reply(950003, 4, "visible");
    expect(open((await views(xiaoyi)).get("a2"))).toMatchObject({ reason: "replied" });
    // 别人回复不影响我
    expect((await views(member)).get("a2")?.status).toBe("locked");
  });

  it("price 0 的门控：需要解锁记录才开放（不是自动放行）", async () => {
    // 把 a1 改成免费门控
    await getWebDb().execute(
      sql`UPDATE post_gates SET conditions = '[{"type":"points","price":0}]' WHERE id = ${DEMO.pointsGate}`,
    );
    expect((await views(xiaoyi)).get("a1")).toMatchObject({
      status: "locked",
      prompts: [{ kind: "points", price: 0 }],
    });
    await getWebDb().insert(gateUnlocks).values({
      gateId: DEMO.pointsGate,
      userId: DEMO.xiaoyi,
      pricePaid: 0,
      authorIncome: 0,
      unlockedAt: "2026-10-15 00:00:00",
    });
    expect(open((await views(xiaoyi)).get("a1"))).toMatchObject({
      reason: "unlocked",
      pricePaid: 0,
    });
  });

  it("脏数据封闭：未知条件类型 / 空条件，普通观众锁定且看不到正文，作者仍可见", async () => {
    const db = getWebDb();
    await db.execute(
      sql`UPDATE post_gates SET conditions = '[{"type":"mystery"}]' WHERE id = ${DEMO.pointsGate}`,
    );
    await db.execute(sql`UPDATE post_gates SET conditions = '[]' WHERE id = ${DEMO.replyGate}`);
    const v = await views(member);
    expect(v.get("a1")).toMatchObject({ status: "locked", prompts: [{ kind: "unavailable" }] });
    expect(v.get("a2")).toMatchObject({ status: "locked", prompts: [{ kind: "unavailable" }] });
    expect(JSON.stringify([...v])).not.toContain("隐藏正文");
    expect(open((await views(alice)).get("a1"))?.reason).toBe("author");
  });

  it("没有门控的帖子 / hasGate=false：零查询，返回空", async () => {
    expect(
      (await loadGateViews(guest, THREAD, [{ id: 900101, authorId: DEMO.alice, hasGate: false }]))
        .size,
    ).toBe(0);
    expect((await loadGateViews(guest, THREAD, [])).size).toBe(0);
  });

  describe("getGateContent 单门控出口", () => {
    it("可见帖子里的门控：按观众判定", async () => {
      expect((await getGateContent(guest, DEMO.pointsGate))?.status).toBe("locked");
      expect(open(await getGateContent(alice, DEMO.pointsGate))?.reason).toBe("author");
    });

    it("门控不存在 → null", async () => {
      expect(await getGateContent(alice, 424242)).toBeNull();
    });

    it("所在帖子对观众不可见 → null（不因知道门控 id 就能读）", async () => {
      const db = getWebDb();
      // 把主题移到受限版块 904：游客/普通会员读不到该版块
      await db
        .update(threads)
        .set({ forumId: DEMO.restrictedForum })
        .where(eq(threads.id, THREAD.id));
      expect(await getGateContent(guest, DEMO.pointsGate)).toBeNull();
      expect(await getGateContent(member, DEMO.pointsGate)).toBeNull();
      expect(await getGateContent(xiaoyi, DEMO.replyGate)).toBeNull();
      // 能读该版块的团队成员 / admin 照常判定
      expect(await getGateContent(await loadSubject(DEMO.team), DEMO.pointsGate)).not.toBeNull();
      expect(open(await getGateContent(admin, DEMO.pointsGate))?.reason).toBe("moderator");

      // 帖子被隐藏（版块可读但状态不可见）：作者本人也读不到
      await db.update(threads).set({ forumId: THREAD.forumId }).where(eq(threads.id, THREAD.id));
      await db.update(posts).set({ state: "hidden" }).where(eq(posts.id, DEMO.gatePost));
      expect(await getGateContent(alice, DEMO.pointsGate)).toBeNull();
      expect(await getGateContent(member, DEMO.pointsGate)).toBeNull();
      expect(open(await getGateContent(admin, DEMO.pointsGate))).not.toBeNull();
    });
  });
});
