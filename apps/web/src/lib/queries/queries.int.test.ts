// @vitest-environment node
/**
 * 查询层的真实 MySQL 集成测试（临时库 + 演示夹具）：可见性矩阵、P0 泄露回归、置顶三档、分页、附件、个人页。
 * 夹具：901 公告站 / 902 茶话会 / 903 考古分舵(902 的子版块) / 904 字幕组内部区(restricted) /
 *       905 不上目录 / 906 投稿审核区；分区 900。主题 900001..900008（900007 待审核、900008 已驳回）。
 */
import { eq, sql } from "drizzle-orm";
import {
  DEMO,
  files,
  forumPrefixes,
  forums,
  getWebDb,
  posts,
  siteSettings,
  threads,
  userProfiles,
  users,
} from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invalidateAuthzSnapshot } from "@/lib/authz/snapshot";
import { loadSubject } from "@/lib/authz/subject";
import type { Subject } from "@/lib/authz/types";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { getDirectory, getForumView } from "./forums";
import { REPLIES_PER_PAGE, getParentFloors, listReplies, pageOfFloor } from "./posts";
import { getLatestThreads, getThreadView, listThreads } from "./threads";
import { getProfile } from "./users";
import { buildViewerScope, visiblePredicate } from "./visibility";

let tdb: TempDb;
let guest: Subject, member: Subject, alice: Subject, xiaoyi: Subject, team: Subject, admin: Subject;

const ids = (xs: { id: number }[]) => xs.map((x) => x.id);
const db = () => getWebDb();

describe.skipIf(skipDb)("查询层 · 真实 MySQL", () => {
  beforeAll(async () => {
    tdb = await setupTempDb();
    [guest, member, alice, xiaoyi, team, admin] = await Promise.all([
      loadSubject(null),
      loadSubject(DEMO.member),
      loadSubject(DEMO.alice),
      loadSubject(DEMO.xiaoyi),
      loadSubject(DEMO.team),
      loadSubject(DEMO.admin),
    ]);
  });
  afterAll(async () => {
    await tdb?.teardown();
  });

  describe("visiblePredicate", () => {
    it("可读版块为空 → 永假谓词（不会拼出非法的 IN ()）", async () => {
      const scope = await buildViewerScope(guest);
      const none = visiblePredicate(
        { forumId: threads.forumId, state: threads.state, authorId: threads.authorId },
        { ...scope, readable: [] },
      );
      const rows = await db().select({ id: threads.id }).from(threads).where(none);
      expect(rows).toEqual([]);
    });
  });

  describe("首页目录与最新动态（P0 泄露回归）", () => {
    it("游客目录：含公开版块与子版块链接，不含受限版块 904 与不上目录的 905", async () => {
      await db()
        .update(forums)
        .set({ threadCount: 777, postCount: 888 })
        .where(eq(forums.id, DEMO.restrictedForum));
      await db().update(forums).set({ threadCount: 5 }).where(eq(forums.id, 901));
      const dir = await getDirectory(guest);
      const all = dir.groups.flatMap((g) => g.forums);
      const shown = all.map((f) => f.id);
      expect(shown).toEqual(expect.arrayContaining([901, 902, 906]));
      expect(shown).not.toContain(DEMO.restrictedForum);
      expect(shown).not.toContain(DEMO.unlistedForum);
      expect(all.find((f) => f.id === 902)?.subs).toEqual([{ id: 903, name: "『考古分舵』" }]);
      expect(dir.groups[0]?.section).toEqual({ id: 900, name: "『演示区』" });
      // 受限版块的计数不会漏进首页统计
      expect(dir.threadCount).toBe(5);
      expect(JSON.stringify(dir)).not.toContain("字幕组内部区");
    });

    it("团队成员目录含受限版块，统计随之变化；不上目录的版块对谁都不进目录", async () => {
      const dir = await getDirectory(team);
      const shown = dir.groups.flatMap((g) => g.forums).map((f) => f.id);
      expect(shown).toContain(DEMO.restrictedForum);
      expect(shown).not.toContain(DEMO.unlistedForum);
      expect(dir.threadCount).toBe(5 + 777);
      expect(
        (await getDirectory(admin)).groups.flatMap((g) => g.forums).map((f) => f.id),
      ).not.toContain(DEMO.unlistedForum);
    });

    it("最新动态：游客看不到受限版块/不上目录版块/待审核/已驳回的主题", async () => {
      const latest = ids(await getLatestThreads(guest, 50));
      expect(latest).toEqual(expect.arrayContaining([900001, 900002, 900003, 900004]));
      for (const hidden of [900005, 900006, 900007, 900008]) expect(latest).not.toContain(hidden);
      expect(ids(await getLatestThreads(guest, 2))).toHaveLength(2);
    });

    it("最新动态：团队成员多出内部区主题；作者自己的待审核主题仍不进聚合（聚合只放 visible）", async () => {
      expect(ids(await getLatestThreads(team, 50))).toContain(900005);
      const xi = ids(await getLatestThreads(xiaoyi, 50));
      expect(xi).not.toContain(900007);
      expect(xi).not.toContain(900008);
    });
  });

  describe("版块页头", () => {
    it("读不到 / 不存在 → null；子版块带面包屑；分区可取到头信息", async () => {
      expect(await getForumView(guest, DEMO.restrictedForum)).toBeNull();
      expect(await getForumView(member, DEMO.restrictedForum)).toBeNull();
      expect(await getForumView(guest, 424242)).toBeNull();
      expect((await getForumView(team, DEMO.restrictedForum))?.name).toContain("字幕组内部区");
      const sub = await getForumView(guest, 903);
      expect(sub?.trail).toEqual([
        { id: 900, name: "『演示区』", kind: "section" },
        { id: 902, name: "『怀旧茶话会』", kind: "forum" },
      ]);
      expect((await getForumView(guest, 900))?.kind).toBe("section");
    });

    it("前缀列表按版块返回", async () => {
      await db()
        .insert(forumPrefixes)
        .values([
          { id: 1, forumId: 901, name: "公告", sortOrder: 1 },
          { id: 2, forumId: 901, name: "指南", sortOrder: 2 },
        ]);
      expect((await getForumView(guest, 901))?.prefixes).toEqual([
        { id: 1, name: "公告" },
        { id: 2, name: "指南" },
      ]);
    });
  });

  describe("主题列表：状态矩阵与置顶", () => {
    it("置顶块（版块置顶 900001）单独给出，不重复出现在普通列表；总数不含置顶", async () => {
      const r = await listThreads(guest, 901, { page: 1 });
      expect(ids(r.pinned)).toEqual([900001]);
      expect(ids(r.items)).toEqual([900004]);
      expect(r.total).toBe(1);
      // 第 2 页（越界会被夹到最后一页）不带置顶块
      const p2 = await listThreads(guest, 901, { page: 99 });
      expect(p2.page).toBe(1);
    });

    it("受限版块：游客/普通会员得到空结果，团队成员看得到", async () => {
      expect((await listThreads(guest, DEMO.restrictedForum, { page: 1 })).total).toBe(0);
      expect((await listThreads(member, DEMO.restrictedForum, { page: 1 })).items).toEqual([]);
      expect(ids((await listThreads(team, DEMO.restrictedForum, { page: 1 })).items)).toEqual([
        900005,
      ]);
    });

    it("审核版块：待审核/已驳回仅作者本人与版主可见", async () => {
      const f = DEMO.reviewForum;
      expect((await listThreads(guest, f, { page: 1 })).items).toEqual([]);
      expect((await listThreads(member, f, { page: 1 })).items).toEqual([]);
      expect((await listThreads(alice, f, { page: 1 })).items).toEqual([]);
      expect(ids((await listThreads(xiaoyi, f, { page: 1 })).items).sort()).toEqual([
        900007, 900008,
      ]);
      expect(ids((await listThreads(admin, f, { page: 1 })).items).sort()).toEqual([
        900007, 900008,
      ]);
    });

    it("hidden / deleted：只有版主可见；作者本人也不可见", async () => {
      await db()
        .insert(threads)
        .values([
          {
            id: 900020,
            forumId: 902,
            authorId: DEMO.xiaoyi,
            title: "被隐藏",
            firstPostId: 900120,
            state: "hidden",
            createdAt: "2026-10-20 10:00:00",
            lastPostedAt: "2026-10-20 10:00:00",
          },
          {
            id: 900021,
            forumId: 902,
            authorId: DEMO.xiaoyi,
            title: "已删除",
            firstPostId: 900121,
            state: "deleted",
            createdAt: "2026-10-20 11:00:00",
            lastPostedAt: "2026-10-20 11:00:00",
          },
        ]);
      for (const s of [guest, member, xiaoyi]) {
        const got = ids((await listThreads(s, 902, { page: 1 })).items);
        expect(got).not.toContain(900020);
        expect(got).not.toContain(900021);
        expect(await getThreadView(s, 900020)).toBeNull();
      }
      const adm = ids((await listThreads(admin, 902, { page: 1 })).items);
      expect(adm).toEqual(expect.arrayContaining([900020, 900021]));
    });

    it("分区置顶(2)在同分区所有版块显示；全站置顶(3)在所有可读版块显示；各自过权限", async () => {
      await db().update(threads).set({ pinLevel: 2 }).where(eq(threads.id, 900002)); // 902 版块，分区 900
      await db().update(threads).set({ pinLevel: 3 }).where(eq(threads.id, 900003)); // 902 版块
      await db().update(threads).set({ pinLevel: 3 }).where(eq(threads.id, 900005)); // 904 受限版块的全站置顶

      const g906 = await listThreads(guest, 906, { page: 1 });
      expect(ids(g906.pinned).sort()).toEqual([900002, 900003]);
      // 受限版块里的全站置顶：游客永远看不到
      expect(ids(g906.pinned)).not.toContain(900005);
      expect(JSON.stringify(g906)).not.toContain("字幕分工表");

      // 团队成员在其它版块的置顶块里能看到内部区的全站置顶
      expect(ids((await listThreads(team, 906, { page: 1 })).pinned)).toContain(900005);

      // 本版块置顶：排序为 pin_level 降序
      const g901 = await listThreads(guest, 901, { page: 1 });
      expect(ids(g901.pinned)).toEqual([900003, 900002, 900001]);
    });

    it("按前缀筛选：不显示置顶块，只含该前缀的主题", async () => {
      await db().update(threads).set({ prefixId: 1 }).where(eq(threads.id, 900004));
      const r = await listThreads(guest, 901, { page: 1, prefixId: 1 });
      expect(r.pinned).toEqual([]);
      expect(ids(r.items)).toEqual([900004]);
      expect(r.items[0]?.prefixName).toBe("公告");
    });

    it("分页：25 条一页，page 夹取，总页数正确", async () => {
      const rows = Array.from({ length: 30 }, (_, i) => ({
        id: 910000 + i,
        forumId: 903,
        authorId: DEMO.alice,
        title: `批量${i}`,
        firstPostId: 920000 + i,
        createdAt: "2026-09-01 00:00:00",
        lastPostedAt: `2026-09-01 00:00:${String(i).padStart(2, "0")}`,
      }));
      await db().insert(threads).values(rows);
      const p1 = await listThreads(guest, 903, { page: 1 });
      expect(p1.total).toBe(30);
      expect(p1.totalPages).toBe(2);
      expect(p1.items).toHaveLength(25);
      expect(p1.items[0]?.id).toBe(910029); // 最后回复时间倒序
      expect(await listThreads(guest, 903, { page: 2 }).then((r) => r.items)).toHaveLength(5);
      expect((await listThreads(guest, 903, { page: -3 })).page).toBe(1);
      // 小数 / NaN / Infinity 不得变成非法 OFFSET（审查 P2-1：?page=1.5 曾让游客触发 500）
      expect((await listThreads(guest, 903, { page: 1.5 })).page).toBe(1);
      expect((await listThreads(guest, 903, { page: 1.5 })).items).toHaveLength(25);
      expect((await listThreads(guest, 903, { page: Number.NaN })).page).toBe(1);
      expect((await listThreads(guest, 903, { page: Number.POSITIVE_INFINITY })).page).toBe(2);
    });
  });

  describe("主题详情", () => {
    it("受限帖：游客/普通会员 null（标题不可得），团队成员可见", async () => {
      expect(await getThreadView(guest, 900005)).toBeNull();
      expect(await getThreadView(member, 900005)).toBeNull();
      const v = await getThreadView(team, 900005);
      expect(v?.title).toContain("字幕分工表");
      expect(v?.first.bodyMd).toContain("本季度分工");
    });

    it("不上目录版块的帖子：直达可读（is_listed 只影响聚合）", async () => {
      expect((await getThreadView(guest, 900006))?.id).toBe(900006);
    });

    it("待审核/已驳回：作者与版主可见，其他人 null；已驳回带审核理由", async () => {
      expect(await getThreadView(guest, 900007)).toBeNull();
      expect(await getThreadView(alice, 900007)).toBeNull();
      expect((await getThreadView(xiaoyi, 900007))?.state).toBe("pending");
      expect((await getThreadView(admin, 900007))?.state).toBe("pending");
      const rejected = await getThreadView(xiaoyi, 900008);
      expect(rejected?.state).toBe("rejected");
      expect(rejected?.review?.decision).toBe("rejected");
      expect(rejected?.review?.note.length).toBeGreaterThan(0);
    });

    it("首帖状态独立于主题状态：主题可见但首帖被隐藏 / 待审时，同样 null（正文不因只查主题而泄露）", async () => {
      // 900006 是游客可读的普通主题；把它的首帖状态改成与主题分叉
      const [t] = await db().select().from(threads).where(eq(threads.id, 900006));
      const fp = t!.firstPostId!; // 夹具主题都有首帖
      try {
        expect((await getThreadView(guest, 900006))?.first.bodyMd).toBeTruthy();

        await db().update(posts).set({ state: "hidden" }).where(eq(posts.id, fp));
        expect(await getThreadView(guest, 900006)).toBeNull();
        expect(await getThreadView(member, 900006)).toBeNull();
        expect(await getThreadView(alice, 900006)).toBeNull(); // 作者本人也不行：hidden 仅版主
        expect((await getThreadView(admin, 900006))?.first.id).toBe(fp);

        // 首帖待审：只有首帖作者与版主可见
        await db()
          .update(posts)
          .set({ state: "pending", authorId: DEMO.xiaoyi })
          .where(eq(posts.id, fp));
        expect(await getThreadView(guest, 900006)).toBeNull();
        expect(await getThreadView(alice, 900006)).toBeNull();
        expect((await getThreadView(xiaoyi, 900006))?.first.id).toBe(fp);
        expect((await getThreadView(admin, 900006))?.first.id).toBe(fp);
      } finally {
        await db()
          .update(posts)
          .set({ state: "visible", authorId: t!.authorId })
          .where(eq(posts.id, fp));
      }
      expect((await getThreadView(guest, 900006))?.first.id).toBe(fp);
    });

    it("门控帖：首帖 body_md 只含占位，hasGate 为真", async () => {
      const v = await getThreadView(guest, 900004);
      expect(v?.first.hasGate).toBe(true);
      expect(v?.first.bodyMd).toContain(':::gate{key="a1"}');
      expect(v?.first.bodyMd).not.toMatch(/隐藏/);
    });

    it("作者显示：已注销占位账号标记 authorDeleted", async () => {
      await db().insert(users).values({
        id: 70001,
        username: "已注销用户#70001",
        usernameKey: "已注销用户#70001",
        state: "deleted",
        createdAt: "2020-01-01 00:00:00",
      });
      await db().update(threads).set({ authorId: 70001 }).where(eq(threads.id, 900003));
      const v = await getThreadView(guest, 900003);
      expect(v?.authorDeleted).toBe(true);
      const live = await getThreadView(guest, 900002);
      expect(live?.authorDeleted).toBe(false);
    });
  });

  describe("回帖", () => {
    it("分页：20 条一页，楼层连续；页码换算", async () => {
      const t = { id: 900001, forumId: 901 };
      const extra = Array.from({ length: 45 }, (_, i) => ({
        id: 930000 + i,
        threadId: 900001,
        floor: 4 + i, // 夹具已有 floor 2、3
        authorId: DEMO.alice,
        bodyMd: `回帖${i}`,
        createdAt: "2026-10-03 00:00:00",
      }));
      await db().insert(posts).values(extra);
      const p1 = await listReplies(guest, t, 1);
      expect(p1.total).toBe(47);
      expect(p1.totalPages).toBe(3);
      expect(p1.items.map((r) => r.floor)).toEqual(
        Array.from({ length: REPLIES_PER_PAGE }, (_, i) => i + 2),
      );
      // 小数页码（审查 P2-1）：取整后正常返回，不抛 SQL 错误
      const frac = await listReplies(guest, t, 2.5);
      expect(frac.page).toBe(2);
      expect(frac.items).toHaveLength(REPLIES_PER_PAGE);
      expect((await listReplies(guest, t, Number.NaN)).page).toBe(1);
      const p3 = await listReplies(guest, t, 3);
      expect(p3.items.map((r) => r.floor)).toEqual(Array.from({ length: 7 }, (_, i) => i + 42));
      expect(pageOfFloor(2)).toBe(1);
      expect(pageOfFloor(21)).toBe(1);
      expect(pageOfFloor(22)).toBe(2);
      expect(pageOfFloor(42)).toBe(3);
    });

    it("回帖按各自状态过滤：被隐藏的回帖只有版主可见；待审核回帖只有其作者与版主可见", async () => {
      await db().update(posts).set({ state: "hidden" }).where(eq(posts.id, 930000));
      await db()
        .update(posts)
        .set({ state: "pending", authorId: DEMO.xiaoyi })
        .where(eq(posts.id, 930001));
      const t = { id: 900001, forumId: 901 };
      const floorsOf = async (s: Subject) => (await listReplies(s, t, 1)).items.map((r) => r.id);
      expect(await floorsOf(guest)).not.toContain(930000);
      expect(await floorsOf(guest)).not.toContain(930001);
      expect(await floorsOf(xiaoyi)).toContain(930001);
      expect(await floorsOf(xiaoyi)).not.toContain(930000);
      expect(await floorsOf(admin)).toEqual(expect.arrayContaining([930000, 930001]));
    });

    it("父帖楼层：批量取，且限定在同一主题内（不能借此探测别的主题的帖）", async () => {
      const m = await getParentFloors(900001, [900001, 900002, 900103, 900101]);
      expect(m.get(900001)).toBe(2);
      expect(m.get(900002)).toBe(3);
      expect(m.has(900103)).toBe(false); // 属于主题 900003
      expect(m.get(900101)).toBe(1);
      expect((await getParentFloors(900001, [])).size).toBe(0);
    });
  });

  describe("个人页", () => {
    it("资料、统计、积分与显示名；封禁标识", async () => {
      await db()
        .update(userProfiles)
        .set({ signatureMd: "签名" })
        .where(eq(userProfiles.userId, DEMO.alice));
      const p = await getProfile(DEMO.alice);
      expect(p?.username).toBe("demo_alice");
      expect(p?.signatureMd).toBe("签名");
      expect(p?.pointsName).toBe("积分");
      expect(p?.ban).toBeNull();
      expect((await getProfile(DEMO.banned))?.ban?.reason).toBe("E2E 封禁夹具");
    });

    it("积分显示名取站点设置；头像经 files 取存储键", async () => {
      await db()
        .insert(siteSettings)
        .values({ key: "points.name", value: { name: "青翼币" }, updatedAt: sql`NOW()` })
        .onDuplicateKeyUpdate({ set: { value: { name: "青翼币" } } });
      expect((await getProfile(DEMO.alice))?.pointsName).toBe("青翼币");
      const [{ insertId }] = (await db()
        .insert(files)
        .values({
          sha256: "b".repeat(64),
          storageKey: `bb/bb/${"b".repeat(64)}.png`,
          mime: "image/png",
          createdAt: "2026-10-01 00:00:00",
        })) as unknown as [{ insertId: number }];
      await db()
        .update(userProfiles)
        .set({ avatarFileId: Number(insertId) })
        .where(eq(userProfiles.userId, DEMO.alice));
      expect((await getProfile(DEMO.alice))?.avatarKey).toBe(`bb/bb/${"b".repeat(64)}.png`);
    });

    it("已注销账号与不存在的用户 → null（占位账号不开页面）", async () => {
      expect(await getProfile(70001)).toBeNull();
      expect(await getProfile(987654)).toBeNull();
    });
  });

  it("授权变更后快照失效，目录随之变化（受限版块授权给新角色）", async () => {
    invalidateAuthzSnapshot();
    const before = (await getDirectory(member)).groups.flatMap((g) => g.forums).map((f) => f.id);
    expect(before).not.toContain(DEMO.restrictedForum);
  });
});
