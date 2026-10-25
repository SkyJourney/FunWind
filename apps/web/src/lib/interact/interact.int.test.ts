// @vitest-environment node
/**
 * 互动写路径集成测试（M8 S2）：点赞/关注 toggle 与计数同步、标签解析与替换、outbox 事件行。
 */
import { and, eq, sql } from "drizzle-orm";
import { follows, getWebDb, posts, reactions, siteSettings, userStats } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSubject } from "@/lib/authz/subject";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { eventOutbox } from "@funwind/db";
import { likedPostIds, reactorsOf, toggleLike } from "./reactions";
import { followedTargetIds, toggleFollow } from "./follows";
import { forumTagCloud, replaceThreadTags, resolveTagIds, tagsOfThreads } from "./tags";
import { createThread } from "@/lib/posting/service";

let tdb: TempDb;
const TEAM_ID = 90006; // DEMO.team
const db = () => getWebDb();

beforeAll(async () => {
  tdb = await setupTempDb();
  await relaxLimits();
});

afterAll(async () => {
  await tdb?.teardown();
});

/** 放宽发帖频控（与 service.int.test 同法） */
async function relaxLimits() {
  const value = {
    titleMax: 100,
    bodyMax: 50000,
    roles: {
      member: { postIntervalSec: 0, threadsPerDay: 0, uploadsPerDay: 20, editWindowSec: 0 },
      admin: { postIntervalSec: 0, threadsPerDay: 0, uploadsPerDay: 0, editWindowSec: 0 },
    },
  };
  await db()
    .insert(siteSettings)
    .values({ key: "limits", value: value as object, updatedAt: sql`NOW()` })
    .onDuplicateKeyUpdate({ set: { value: value as object, updatedAt: sql`NOW()` } });
}

async function likeCountOf(postId: number): Promise<number> {
  const [row] = await db().select({ c: posts.likeCount }).from(posts).where(eq(posts.id, postId));
  return row?.c ?? 0;
}

describe.skipIf(skipDb)("点赞（reactions）", () => {
  it("toggle：赞 → 计数 +1 + 明细行 + outbox 事件；再点 → 取消归零", async () => {
    const postId = 900104; // seed 门控帖首帖（alice 作者）
    const before = await likeCountOf(postId);

    const r1 = await toggleLike(TEAM_ID, postId);
    expect(r1).toMatchObject({ ok: true, liked: true });
    expect((r1 as { likeCount: number }).likeCount).toBe(before + 1);
    const [rx] = await db()
      .select()
      .from(reactions)
      .where(and(eq(reactions.userId, TEAM_ID), eq(reactions.postId, postId)));
    expect(rx.kind).toBe("like");
    const [ob] = await db()
      .select()
      .from(eventOutbox)
      .where(and(eq(eventOutbox.eventName, "reaction.added"), eq(eventOutbox.actorId, TEAM_ID)));
    expect(ob.dispatchedAt).not.toBeNull();

    const r2 = await toggleLike(TEAM_ID, postId);
    expect(r2).toMatchObject({ ok: true, liked: false });
    expect((r2 as { likeCount: number }).likeCount).toBe(before);
    expect(
      (
        await db()
          .select()
          .from(reactions)
          .where(and(eq(reactions.userId, TEAM_ID), eq(reactions.postId, postId)))
      ).length,
    ).toBe(0);
    // 取消不发新事件（outbox 行只有点赞方向的那条）
    const obs = await db()
      .select()
      .from(eventOutbox)
      .where(and(eq(eventOutbox.eventName, "reaction.added"), eq(eventOutbox.actorId, TEAM_ID)));
    expect(obs).toHaveLength(1);
  });

  it("不可见帖子：not_found 不计数", async () => {
    // 待审核主题 900007 的首帖（非作者不可见）
    const [hiddenPost] = await db()
      .select({ id: posts.id })
      .from(posts)
      .where(eq(posts.threadId, 900007))
      .limit(1);
    expect(hiddenPost).toBeDefined();
    const before = await likeCountOf(hiddenPost.id);
    expect(await toggleLike(TEAM_ID, hiddenPost.id)).toEqual({ ok: false, code: "not_found" });
    expect(await likeCountOf(hiddenPost.id)).toBe(before);
  });

  it("likedPostIds / reactorsOf：批量状态与点赞者列表", async () => {
    const postId = 900104;
    await toggleLike(TEAM_ID, postId);
    expect((await likedPostIds(TEAM_ID, [postId, 900101])).has(postId)).toBe(true);
    const reactors = await reactorsOf(postId);
    expect(reactors.some((r) => r.userId === TEAM_ID)).toBe(true);
    await toggleLike(TEAM_ID, postId); // 还原
  });
});

describe.skipIf(skipDb)("关注（follows）", () => {
  it("关注用户：follower_count 同步；取关回落；事件经 outbox", async () => {
    const target = 90001; // alice
    const [before] = await db()
      .select({ c: userStats.followerCount })
      .from(userStats)
      .where(eq(userStats.userId, target));

    const r1 = await toggleFollow(TEAM_ID, "user", target);
    expect(r1).toMatchObject({ ok: true, following: true });
    const [mid] = await db()
      .select({ c: userStats.followerCount })
      .from(userStats)
      .where(eq(userStats.userId, target));
    expect(mid.c).toBe(before.c + 1);
    expect(
      (
        await db()
          .select()
          .from(follows)
          .where(
            and(
              eq(follows.userId, TEAM_ID),
              eq(follows.targetType, "user"),
              eq(follows.targetId, target),
            ),
          )
      ).length,
    ).toBe(1);
    const [ob] = await db()
      .select()
      .from(eventOutbox)
      .where(and(eq(eventOutbox.eventName, "user.followed"), eq(eventOutbox.actorId, TEAM_ID)));
    expect(ob.dispatchedAt).not.toBeNull();

    await toggleFollow(TEAM_ID, "user", target);
    const [after] = await db()
      .select({ c: userStats.followerCount })
      .from(userStats)
      .where(eq(userStats.userId, target));
    expect(after.c).toBe(before.c);
  });

  it("关注版块与自关注拒绝；followedTargetIds 批量状态", async () => {
    expect(await toggleFollow(TEAM_ID, "user", TEAM_ID)).toEqual({ ok: false, code: "not_found" });
    expect(await toggleFollow(TEAM_ID, "forum", 901)).toMatchObject({ ok: true, following: true });
    expect((await followedTargetIds(TEAM_ID, "forum", [901, 902])).has(901)).toBe(true);
    expect(await followedTargetIds(TEAM_ID, "user", [90001])).toEqual(new Set());
    await toggleFollow(TEAM_ID, "forum", 901); // 还原
  });
});

describe.skipIf(skipDb)("标签（tags）", () => {
  it("resolveTagIds：已有标签直接命中；新标签须 canAdd；超上限拒绝", async () => {
    await db().transaction(async (tx) => {
      const r1 = await resolveTagIds(tx, ["字幕", "新标签X"], false);
      expect(r1).toMatchObject({ ok: false, code: "tag_denied" });
      const r2 = await resolveTagIds(tx, ["字幕", "新标签X"], true);
      expect(r2.ok).toBe(true);
      expect((r2 as { tagIds: number[] }).tagIds.length).toBe(2);
      const r3 = await resolveTagIds(tx, ["字幕", "新标签X"], false);
      expect(r3.ok).toBe(true); // 上一轮已创建，现在可以命中
      const r4 = await resolveTagIds(tx, ["a", "b", "c", "d", "e", "f"], true);
      expect(r4).toMatchObject({ ok: false, code: "tag_too_many" });
    });
  });

  it("replaceThreadTags + tagsOfThreads + forumTagCloud", async () => {
    await db().transaction(async (tx) => {
      const r = await resolveTagIds(tx, ["字幕", "日剧"], true);
      if (!r.ok) throw new Error(r.code);
      await replaceThreadTags(tx, 900001, r.tagIds);
    });
    const map = await tagsOfThreads([900001]);
    expect((map.get(900001) ?? []).map((t) => t.name).sort()).toEqual(["日剧", "字幕"].sort());
    const cloud = await forumTagCloud(901);
    expect(cloud.some((t) => t.name === "字幕")).toBe(true);
    expect(cloud.every((t) => t.count >= 1)).toBe(true);
    // 还原（seed 的 900001 原无标签）
    await db().transaction(async (tx) => {
      await replaceThreadTags(tx, 900001, []);
    });
  });

  it("createThread 带 tags：发帖即打标签；无 canAdd 时未知标签拒绝", async () => {
    const alice = await loadSubject(90001);
    const r1 = await createThread(
      alice,
      {
        forumId: 901,
        title: "E2E 标签主题",
        source: "正文",
        tags: ["字幕", "E2E新标签"],
        canAddTags: true,
      },
      {},
    );
    if (!r1.ok) throw new Error(r1.message);
    const map = await tagsOfThreads([r1.threadId]);
    expect((map.get(r1.threadId) ?? []).map((t) => t.name).sort()).toEqual(
      ["E2E新标签", "字幕"].sort(),
    );

    const r2 = await createThread(
      alice,
      {
        forumId: 901,
        title: "E2E 标签拒绝",
        source: "正文",
        tags: ["全新无权标签"],
        canAddTags: false,
      },
      {},
    );
    expect(r2.ok).toBe(false);
    expect((r2 as { code: string }).code).toBe("tag_denied");
  });
});

describe.skipIf(skipDb)(
  "计数一致性抽查（M8 门禁 4：随机 20 帖 like_count ↔ reactions 明细）",
  () => {
    it("全部抽样帖子的缓存计数与明细 COUNT 一致", async () => {
      const rows = await db()
        .select({ id: posts.id, likeCount: posts.likeCount })
        .from(posts)
        .orderBy(sql`RAND()`)
        .limit(20);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const [{ n }] = await db()
          .select({ n: sql<number>`COUNT(*)` })
          .from(reactions)
          .where(and(eq(reactions.postId, row.id), eq(reactions.kind, "like")));
        expect(Number(n), `帖子 ${row.id}`).toBe(row.likeCount);
      }
    });

    it("粉丝计数一致：全部用户 follower_count ↔ follows 明细", async () => {
      const result = await db().execute(
        sql`SELECT u.user_id FROM user_stats u
          WHERE u.follower_count <> (SELECT COUNT(*) FROM follows f WHERE f.target_type = 'user' AND f.target_id = u.user_id)`,
      );
      const rows = (Array.isArray(result) ? result[0] : result) as unknown as unknown[];
      expect(rows).toHaveLength(0);
    });
  },
);
