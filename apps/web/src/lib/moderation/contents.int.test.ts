// @vitest-environment node
/**
 * 内容管理查询与主题级设置（M9.5 §9.2-A/C）：临时库覆盖主题/回帖两分支、六态筛选、
 * 关键词、作用域过滤、封禁作者徽标、setThreadFlags 的权限递减（版主置顶上限 1）。
 */
import "@/modules";
import { and, eq } from "drizzle-orm";
import { DEMO, getWebDb, posts, threads, userRoles } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assignUserRole, createCustomRole, grantRolePermission } from "@/lib/authz/admin";
import { invalidateAuthzSnapshot } from "@/lib/authz/snapshot";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { listContentsPage, setThreadFlags } from "./contents";

let tdb: TempDb;
const db = () => getWebDb();
const REVIEW_FORUM = 906; // seed 的 review_policy=all 版块（demo_admin 有 site.admin，作用域不受限）

async function seedThread(opts: { state: string; title: string }) {
  const [t] = (await db()
    .insert(threads)
    .values({
      forumId: REVIEW_FORUM,
      authorId: DEMO.member,
      title: opts.title,
      firstPostId: 0,
      state: opts.state as never,
      createdAt: "2026-05-01 10:00:00",
    })) as unknown as [{ insertId: number }];
  const [p] = (await db()
    .insert(posts)
    .values({
      threadId: Number(t.insertId),
      authorId: DEMO.member,
      floor: 1,
      bodyMd: `首帖正文 ${opts.title}`,
      state: opts.state as never,
      createdAt: "2026-05-01 10:00:00",
    })) as unknown as [{ insertId: number }];
  await db()
    .update(threads)
    .set({ firstPostId: Number(p.insertId) })
    .where(eq(threads.id, Number(t.insertId)));
  return { threadId: Number(t.insertId), postId: Number(p.insertId) };
}

beforeAll(async () => {
  tdb = await setupTempDb();
});

afterAll(async () => {
  await tdb?.teardown();
});

describe.skipIf(skipDb)("内容管理（M9.5）", () => {
  it("主题分支：六态筛选、标题关键词、封禁作者徽标", async () => {
    const visible = await seedThread({ state: "visible", title: "治理可见主题" });
    await seedThread({ state: "pending", title: "治理待审主题" });
    await seedThread({ state: "disabled", title: "治理封禁主题" });

    // 全部：三态都在
    const all = await listContentsPage({
      kind: "thread",
      state: "all",
      page: 1,
      scopeForumIds: null,
    });
    expect(all.total).toBeGreaterThanOrEqual(3);
    // visible 筛选只含可见
    const vis = await listContentsPage({
      kind: "thread",
      state: "visible",
      page: 1,
      scopeForumIds: null,
    });
    expect(vis.items.every((i) => i.state === "visible")).toBe(true);
    expect(vis.items.some((i) => i.postId === visible.postId)).toBe(true);
    // disabled 筛选（新终态）
    const dis = await listContentsPage({
      kind: "thread",
      state: "disabled",
      page: 1,
      scopeForumIds: null,
    });
    expect(dis.items.every((i) => i.state === "disabled")).toBe(true);
    // 标题关键词
    const byTitle = await listContentsPage({
      kind: "thread",
      q: "治理可见",
      state: "all",
      page: 1,
      scopeForumIds: null,
    });
    expect(byTitle.items.some((i) => i.postId === visible.postId)).toBe(true);
    // 主题行带 replyCount / flags 字段
    const row = vis.items.find((i) => i.postId === visible.postId);
    expect(row?.isThread).toBe(true);
    expect(row?.replyCount).not.toBeNull();
    expect(row?.excerpt).toBeNull();
  });

  it("回帖分支：正文关键词、摘要、state 跟随 posts", async () => {
    const t = await seedThread({ state: "visible", title: "回帖宿主主题" });
    const [p] = (await db().insert(posts).values({
      threadId: t.threadId,
      authorId: DEMO.member,
      floor: 2,
      bodyMd: "这条回帖包含特殊关键词蓝鲸鱼",
      state: "visible",
      createdAt: "2026-05-02 10:00:00",
    })) as unknown as [{ insertId: number }];

    const byBody = await listContentsPage({
      kind: "reply",
      q: "蓝鲸鱼",
      state: "all",
      page: 1,
      scopeForumIds: null,
    });
    expect(byBody.items.some((i) => i.postId === Number(p.insertId))).toBe(true);
    const hit = byBody.items.find((i) => i.postId === Number(p.insertId));
    expect(hit?.isThread).toBe(false);
    expect(hit?.excerpt).toContain("蓝鲸鱼");
    // 状态筛选走 posts.state
    await db()
      .update(posts)
      .set({ state: "hidden" })
      .where(eq(posts.id, Number(p.insertId)));
    const hidden = await listContentsPage({
      kind: "reply",
      state: "hidden",
      page: 1,
      scopeForumIds: null,
    });
    expect(hidden.items.some((i) => i.postId === Number(p.insertId))).toBe(true);
  });

  it("作用域过滤：版主只看所辖版块（空数组=无权限 → 恒空）", async () => {
    await seedThread({ state: "visible", title: "作用域可见主题" });
    const scoped = await listContentsPage({
      kind: "thread",
      state: "all",
      page: 1,
      scopeForumIds: [REVIEW_FORUM],
    });
    expect(scoped.items.every((i) => i.forumId === REVIEW_FORUM)).toBe(true);
    const none = await listContentsPage({
      kind: "thread",
      state: "all",
      page: 1,
      scopeForumIds: [],
    });
    expect(none).toMatchObject({ items: [], total: 0 });
  });

  it("setThreadFlags：版主可锁定/精华/版块置顶；置顶到全站被拒；锁定即时生效", async () => {
    const t = await seedThread({ state: "visible", title: "旗标测试主题" });
    const admin = { userId: DEMO.admin, via: "admin" as const, ip: null };

    // site.admin（demo_admin）：全站置顶放行 + 锁定 + 精华
    const r = await setThreadFlags(
      { userId: DEMO.admin },
      t.threadId,
      { locked: true, featured: true, pinLevel: 3 },
      admin,
    );
    expect(r).toEqual({ ok: true });
    const [row] = await db()
      .select({ locked: threads.isLocked, featured: threads.isFeatured, pin: threads.pinLevel })
      .from(threads)
      .where(eq(threads.id, t.threadId));
    expect(row).toEqual({ locked: true, featured: true, pin: 3 });

    // 普通版主视角（member 无 site.admin、非版主）：置顶被拒
    const denied = await setThreadFlags(
      { userId: DEMO.member },
      t.threadId,
      { pinLevel: 3 },
      { userId: DEMO.member, via: "admin", ip: null },
    );
    expect(denied).toMatchObject({ ok: false, code: "forbidden" });

    const roleKey = "contents-moderator";
    await createCustomRole(admin, roleKey, "内容版主", "");
    await grantRolePermission(admin, roleKey, "forum.moderate", REVIEW_FORUM);
    await assignUserRole(admin, DEMO.member, roleKey, 0, null, "版主置顶权限边界测试");
    try {
      const moderator = { userId: DEMO.member, via: "admin" as const, ip: null };
      expect(
        await setThreadFlags({ userId: DEMO.member }, t.threadId, { pinLevel: 1 }, moderator),
      ).toEqual({ ok: true });
      expect(
        await setThreadFlags({ userId: DEMO.member }, t.threadId, { pinLevel: 2 }, moderator),
      ).toMatchObject({ ok: false, code: "bad_pin" });
    } finally {
      await db()
        .delete(userRoles)
        .where(and(eq(userRoles.userId, DEMO.member), eq(userRoles.roleKey, roleKey)));
      invalidateAuthzSnapshot();
    }

    // 不存在的主题
    expect(
      await setThreadFlags({ userId: DEMO.admin }, 99999999, { locked: true }, admin),
    ).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });
});
