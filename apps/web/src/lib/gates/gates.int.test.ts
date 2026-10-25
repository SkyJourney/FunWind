// @vitest-environment node
/**
 * 门控读取服务的真实 MySQL 集成测试（临时库 + 演示夹具）。
 * 夹具：主题 900004（版块 901，作者 alice）首帖 900104 含两个门控——
 *   a1 / id 9001：积分 10，demo_member 已购买（pricePaid 10）；a2 / id 9002：回复可见。
 * 核心断言：锁定的结果序列化后不含任何隐藏文本。
 */
import { eq, sql } from "drizzle-orm";
import { DEMO, gateUnlocks, getWebDb, postGates, posts, threads } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSubject } from "@/lib/authz/subject";
import type { Subject } from "@/lib/authz/types";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { getGateContent, loadGateViews, openGateIds, unlockCountsByGateKey } from "./service";
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

  it("内容更新于（M6.5）：隐藏正文更新后，已解锁者（解锁早于更新）与未解锁者看到标记；作者与版主不看到", async () => {
    // 自包含：临时帖子 + 门控 + 一条早于更新的解锁记录，不依赖其它用例改过的状态
    const POST_ID = 990801;
    const GATE_ID = 990801;
    const db = getWebDb();
    await db.insert(posts).values({
      id: POST_ID,
      threadId: THREAD.id,
      floor: 99,
      authorId: DEMO.alice,
      bodyMd: "",
      hasGate: true,
      state: "visible",
      createdAt: "2026-10-01 00:00:00",
    });
    await db.insert(postGates).values({
      id: GATE_ID,
      postId: POST_ID,
      gateKey: "nz",
      conditions: [{ type: "points", price: 10 }] as never,
      matchMode: "all",
      hiddenMd: "更新标记测试正文",
      createdAt: "2026-10-01 00:00:00",
      updatedAt: "2026-10-01 00:00:00",
    });
    await db.insert(gateUnlocks).values({
      gateId: GATE_ID,
      userId: DEMO.member,
      pricePaid: 10,
      authorIncome: 10,
      unlockedAt: "2026-10-13 09:00:00",
    });
    try {
      // 作者在购买之后改了隐藏正文
      await db.execute(
        sql`UPDATE post_gates SET content_updated_at = '2026-10-20 12:34:56' WHERE id = ${GATE_ID}`,
      );
      const view = async (s: Subject) =>
        (await loadGateViews(s, THREAD, [{ id: POST_ID, authorId: DEMO.alice, hasGate: true }]))
          .get(POST_ID)
          ?.get("nz");
      const note = "内容更新于 2026-10-20 12:34";
      expect(await view(member)).toMatchObject({ status: "open", updateNote: note }); // 解锁早于更新：要提醒
      expect(await view(guest)).toMatchObject({ status: "locked", updateNote: note }); // 未解锁：显示时间
      expect(await view(alice)).toMatchObject({ status: "open", updateNote: null }); // 作者自己改的
      expect(await view(admin)).toMatchObject({ status: "open", updateNote: null }); // 版主随时看最新版
      // 解锁晚于更新：读者已看到最新版本，不再提醒
      await db.execute(
        sql`UPDATE gate_unlocks SET unlocked_at = '2026-10-21 00:00:00' WHERE gate_id = ${GATE_ID}`,
      );
      expect(await view(member)).toMatchObject({ status: "open", updateNote: null });
      // 从未更新：没有标记
      await db.execute(sql`UPDATE post_gates SET content_updated_at = NULL WHERE id = ${GATE_ID}`);
      expect(await view(guest)).toMatchObject({ updateNote: null });
    } finally {
      await db.execute(sql`DELETE FROM gate_unlocks WHERE gate_id = ${GATE_ID}`);
      await db.execute(sql`DELETE FROM post_gates WHERE id = ${GATE_ID}`);
      await db.execute(sql`DELETE FROM posts WHERE id = ${POST_ID}`);
    }
  });

  it("作者编辑页用：解锁人数按门控 key 计数（只计数，不读隐藏正文）；没人解锁的门控不出现", async () => {
    const counts = await unlockCountsByGateKey(DEMO.gatePost);
    expect([...counts.values()].every((n) => n >= 1)).toBe(true);
    expect(counts.size).toBeGreaterThanOrEqual(1);
    expect((await unlockCountsByGateKey(900101)).size).toBe(0);
  });

  it("没有门控的帖子 / hasGate=false：零查询，返回空", async () => {
    expect(
      (await loadGateViews(guest, THREAD, [{ id: 900101, authorId: DEMO.alice, hasGate: false }]))
        .size,
    ).toBe(0);
    expect((await loadGateViews(guest, THREAD, [])).size).toBe(0);
  });

  describe("openGateIds 开放状态（门控附件的放行依据，不读隐藏正文）", () => {
    const BOTH = new Set([DEMO.pointsGate, DEMO.replyGate]);
    const ids = (
      s: Subject,
      gateIds: ReadonlySet<number> = BOTH,
      list: { id: number; authorId: number; hasGate: boolean }[] = FIRST,
    ) => openGateIds(s, THREAD, list, gateIds);

    it("游客一个都不开放；作者与版主全部开放", async () => {
      expect(await ids(guest)).toEqual(new Set());
      expect(await ids(alice)).toEqual(BOTH);
      expect(await ids(admin)).toEqual(BOTH);
    });

    it("与 loadGateViews 的结论逐观众一致——正文与附件两条链路不可分叉", async () => {
      for (const s of [guest, alice, member, xiaoyi, admin]) {
        const fromViews = new Set(
          [...(await views(s)).values()].filter((v) => v.status === "open").map((v) => v.gateId),
        );
        expect(await ids(s), `userId=${s.userId}`).toEqual(fromViews);
      }
    });

    it("只返回被问到的门控", async () => {
      expect(await ids(alice, new Set([DEMO.pointsGate]))).toEqual(new Set([DEMO.pointsGate]));
    });

    it("fail-closed：空集合、不存在的门控、不属于 postList 的门控都不开放（即使是版主）", async () => {
      expect(await ids(admin, new Set())).toEqual(new Set());
      expect(await ids(admin, new Set([424242]))).toEqual(new Set());
      // 门控 9001 属于 DEMO.gatePost；postList 里没有它（或只有别的帖子）时，不得被当成开放
      expect(await ids(admin, BOTH, [])).toEqual(new Set());
      expect(await ids(admin, BOTH, [{ id: 999999, authorId: DEMO.alice, hasGate: true }])).toEqual(
        new Set(),
      );
    });
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

  it("未知条件类型（M6.1 删除 gateConditions 边界后，库里的未知类型只是脏数据）：单门控出口与附件放行判定同样封闭，与正文链路一致", async () => {
    const SECRET = "UNKNOWN-TYPE-SECRET-9";
    // 前一个用例把首帖留在 hidden 状态：先恢复可见，否则测的是「帖子不可见」而不是「条件类型未知」
    await getWebDb().update(posts).set({ state: "visible" }).where(eq(posts.id, DEMO.gatePost));
    const [{ insertId }] = (await getWebDb()
      .insert(postGates)
      .values({
        postId: DEMO.gatePost,
        gateKey: "u9",
        conditions: [{ type: "follow" }],
        matchMode: "all",
        hiddenMd: SECRET,
        createdAt: "2026-10-20 00:00:00",
        updatedAt: "2026-10-20 00:00:00",
      })) as unknown as [{ insertId: number }];
    const gid = Number(insertId);
    const only = new Set([gid]);
    for (const [who, s] of [
      ["游客", guest],
      ["会员", member],
      ["未购买者", xiaoyi],
    ] as const) {
      const v = await getGateContent(s, gid);
      expect(v?.status, who).toBe("locked");
      expect(JSON.stringify(v), who).not.toContain(SECRET);
      expect(await openGateIds(s, THREAD, FIRST, only), `${who}：附件放行`).toEqual(new Set());
      const fromViews = (await views(s)).get("u9");
      expect(fromViews?.status, `${who}：正文链路`).toBe("locked");
      expect(JSON.stringify(fromViews), `${who}：正文链路`).not.toContain(SECRET);
    }
    // 对照：作者与版主仍然能看（便于排查脏数据）
    expect(open(await getGateContent(alice, gid))?.contentMd).toContain(SECRET);
    expect(await openGateIds(admin, THREAD, FIRST, only)).toEqual(only);
  });
});
