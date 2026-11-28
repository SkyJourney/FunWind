// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CONTENT_STATES,
  forums,
  getWebDb,
  postGates,
  posts,
  roleGrants,
  threads,
  users,
} from "@funwind/db";
import { eq, inArray } from "drizzle-orm";
import { readableForumIds } from "@/lib/authz/evaluator";
import * as authz from "@/lib/authz/snapshot";
import { GUEST_SUBJECT } from "@/lib/authz/types";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { isPublicFeedForum, loadFeed } from "./query";

const F = {
  publicSection: 1001,
  parent: 1002,
  child: 1003,
  unlisted: 1004,
  empty: 1005,
  restrictedSection: 1006,
  guestGranted: 1007,
  members: 1008,
  restricted: 1009,
  publicOverride: 1010,
  ranked: 1011,
  orphan: 1012,
};
const AUTHOR_ID = 1100;
const DELETED_AUTHOR_ID = 1101;
const CREATED = "2026-11-25 12:00:00";
const EDITED = "2026-11-26 12:00:00";
const PUBLIC_BODY = ':::gate{key="a1"}\n:::\n\n只有这段是公开正文。';
const PRIVATE_BODY = "只在门控表中保存的秘密正文";
const latest = { kind: "latest" } as const;
const board = (fid: number) => ({ kind: "forum", fid }) as const;
const postId = (id: number) => id + 10_000;

/** 用祖先链同时生成邻接表和物化路径，以实际版块模型建立夹具。 */
function forum(
  name: string,
  chain: number[],
  fields: Pick<typeof forums.$inferInsert, "kind" | "readPolicy" | "isListed"> = {},
): typeof forums.$inferInsert {
  return {
    name,
    id: chain.at(-1),
    parentId: chain.at(-2) ?? 0,
    path: `/${chain.join("/")}/`,
    depth: chain.length,
    ...fields,
  };
}

interface TopicFixture {
  id: number;
  forumId: number;
  authorId?: number;
  createdAt?: string;
  state?: (typeof CONTENT_STATES)[number];
  firstPostId?: number | null;
  postState?: (typeof CONTENT_STATES)[number];
  floor?: number;
  bodyMd?: string | null;
  editedAt?: string;
}

/** 分开设定主题与首帖，允许造出状态分叉和损坏的首帖指针。 */
async function insertTopics(topics: TopicFixture[]): Promise<void> {
  const db = getWebDb();
  await db.insert(threads).values(
    topics.map((topic) => ({
      id: topic.id,
      forumId: topic.forumId,
      authorId: topic.authorId ?? AUTHOR_ID,
      title: `主题 ${topic.id}`,
      createdAt: topic.createdAt ?? CREATED,
      state: topic.state,
      firstPostId: topic.firstPostId === undefined ? postId(topic.id) : topic.firstPostId,
      // 即使旧主题置顶或刚有人回复，也不能挤到新发布的主题前面。
      pinLevel: topic.id === 2099 ? 3 : 0,
      lastPostedAt: topic.id === 2099 ? "2026-11-30 12:00:00" : CREATED,
    })),
  );
  await db.insert(posts).values(
    topics.map((topic) => ({
      id: postId(topic.id),
      threadId: topic.id,
      authorId: topic.authorId ?? AUTHOR_ID,
      floor: topic.floor ?? 1,
      state: topic.postState,
      bodyMd: topic.bodyMd === undefined ? `正文 ${topic.id}` : topic.bodyMd,
      hasGate: topic.bodyMd === PUBLIC_BODY,
      createdAt: "2026-11-24 00:00:00",
      editedAt: topic.editedAt,
    })),
  );
}

/** 50 条同秒主题用反向 ID 检验次序，并以两个不同时间的 ID 验证主排序键。 */
const TIED_IDS = Array.from({ length: 50 }, (_, i) => 2049 - i);

let tdb: TempDb;

describe.skipIf(skipDb)("订阅源查询（真实 MySQL）", () => {
  beforeAll(async () => {
    tdb = await setupTempDb({ demo: false });
    const db = getWebDb();
    await db
      .insert(forums)
      .values([
        forum("公开分区", [F.publicSection], { kind: "section", readPolicy: "public" }),
        forum("父版块", [F.publicSection, F.parent]),
        forum("子版块", [F.publicSection, F.parent, F.child]),
        forum("不进目录", [F.unlisted], { isListed: false }),
        forum("空版块", [F.empty]),
        forum("受限分区", [F.restrictedSection], { kind: "section", readPolicy: "restricted" }),
        forum("游客有授权", [F.restrictedSection, F.guestGranted]),
        forum("会员版块", [F.members], { readPolicy: "members" }),
        forum("受限版块", [F.restricted], { readPolicy: "restricted" }),
        forum("明确公开", [F.restrictedSection, F.publicOverride], { readPolicy: "public" }),
        forum("排序版块", [F.ranked]),
        forum("缺少祖先的版块", [1900, F.orphan]),
      ]);
    await db.insert(roleGrants).values({
      roleKey: "guest",
      permissionKey: "forum.read",
      scopeId: F.restrictedSection,
    });
    await db.insert(users).values([
      { id: AUTHOR_ID, username: "公开作者", usernameKey: "公开作者", createdAt: CREATED },
      {
        id: DELETED_AUTHOR_ID,
        username: "注销前的账号名",
        usernameKey: "注销前的账号名",
        state: "deleted",
        createdAt: CREATED,
      },
    ]);

    const invalidDate = "2026-11-28 12:00:00";
    await insertTopics([
      { id: 101, forumId: F.child, authorId: 999_999, bodyMd: null },
      { id: 102, forumId: F.parent, bodyMd: PUBLIC_BODY, editedAt: EDITED },
      { id: 103, forumId: F.publicOverride, authorId: DELETED_AUTHOR_ID },
      { id: 104, forumId: F.unlisted, createdAt: invalidDate },
      { id: 105, forumId: F.guestGranted, createdAt: invalidDate },
      { id: 106, forumId: F.members, createdAt: invalidDate },
      { id: 107, forumId: F.restricted, createdAt: invalidDate },
      { id: 108, forumId: F.publicSection, createdAt: invalidDate },
      { id: 109, forumId: F.orphan, createdAt: invalidDate },
      ...TIED_IDS.map((id) => ({ id, forumId: F.ranked, createdAt: "2026-11-24 12:00:00" })),
      { id: 1999, forumId: F.ranked, createdAt: "2026-11-24 13:00:00" },
      { id: 2099, forumId: F.ranked, createdAt: "2026-11-24 11:00:00" },
      ...CONTENT_STATES.filter((state) => state !== "visible").flatMap((state, i) => [
        { id: 3000 + 2 * i, forumId: F.ranked, state, createdAt: invalidDate },
        { id: 3001 + 2 * i, forumId: F.ranked, postState: state, createdAt: invalidDate },
      ]),
      { id: 3010, forumId: F.ranked, firstPostId: postId(101), createdAt: invalidDate },
      { id: 3011, forumId: F.ranked, floor: 2, createdAt: invalidDate },
      { id: 3012, forumId: F.ranked, firstPostId: null, createdAt: invalidDate },
      { id: 3013, forumId: F.ranked, firstPostId: 999_999, createdAt: invalidDate },
    ]);
    await db.insert(postGates).values({
      postId: postId(102),
      gateKey: "a1",
      conditions: [{ type: "points", price: 5 }],
      hiddenMd: PRIVATE_BODY,
      createdAt: CREATED,
      updatedAt: CREATED,
    });
  });

  afterAll(async () => {
    authz.invalidateAuthzSnapshot();
    await tdb?.teardown();
  });

  it("父版块只取本版，首帖投影只含公开正文及条目字段", async () => {
    const feed = await loadFeed(board(F.parent));
    expect(feed).toEqual({
      forumName: "父版块",
      entries: [
        {
          id: 102,
          title: "主题 102",
          author: "公开作者",
          createdAt: CREATED,
          editedAt: EDITED,
          bodyMd: PUBLIC_BODY,
        },
      ],
    });
    expect(JSON.stringify(feed)).not.toContain(PRIVATE_BODY);
    expect((await loadFeed(board(F.child)))?.entries).toMatchObject([
      { id: 101, author: "未知用户", bodyMd: "", editedAt: null },
    ]);
    expect((await loadFeed(board(F.publicOverride)))?.entries).toMatchObject([
      { id: 103, author: "已注销用户" },
    ]);
    expect((await loadFeed(board(F.unlisted)))?.entries.map(({ id }) => id)).toEqual([104]);
    expect(await loadFeed(board(F.empty))).toEqual({ forumName: "空版块", entries: [] });
    for (const fid of [F.parent, F.child, F.publicOverride, F.unlisted, F.empty]) {
      expect(await isPublicFeedForum(fid), `版块 ${fid}`).toBe(true);
    }
  });

  it("发现和单版订阅排除分区、继承受限、有游客授权的受限版块、会员和不存在的版块", async () => {
    const snap = await authz.loadFreshAuthzSnapshot(getWebDb());
    expect(readableForumIds(GUEST_SUBJECT, snap)).toContain(F.guestGranted);
    expect(snap.tree.readPolicy(F.guestGranted).value).toBe("restricted");
    for (const fid of [F.publicSection, F.guestGranted, F.restricted, F.members, -1, 999_999]) {
      expect(await loadFeed(board(fid)), `版块 ${fid}`).toBeNull();
      expect(await isPublicFeedForum(fid), `版块 ${fid}`).toBe(false);
    }
  });

  it("继承链无法确认的版块从两类订阅和发现入口中排除", async () => {
    expect(await isPublicFeedForum(F.orphan)).toBe(false);
    expect(await loadFeed(board(F.orphan))).toBeNull();
    const feed = await loadFeed(latest);
    expect(feed?.entries).not.toContainEqual(expect.objectContaining({ id: 109 }));
  });

  it("先在 SQL 中筛出可订阅主题与有效可见首帖，再按发布时间和 ID 截取 50 条", async () => {
    const feed = await loadFeed(latest);
    expect(feed?.forumName).toBeNull();
    expect(feed?.entries.map(({ id }) => id)).toEqual([
      103,
      102,
      101,
      1999,
      ...TIED_IDS.slice(0, 46),
    ]);
    const single = await loadFeed(board(F.ranked));
    expect(single?.entries.map(({ id }) => id)).toEqual([1999, ...TIED_IDS.slice(0, 49)]);
  });

  it("没有可列入全站源的版块时返回有效空源", async () => {
    const ids = [F.parent, F.child, F.publicOverride, F.empty, F.ranked];
    const db = getWebDb();
    await db.update(forums).set({ isListed: false }).where(inArray(forums.id, ids));
    try {
      expect(await loadFeed(latest)).toEqual({ forumName: null, entries: [] });
    } finally {
      await db.update(forums).set({ isListed: true }).where(inArray(forums.id, ids));
    }
  });

  it("授权与内容从同一视图读取，下一次查询和页面发现即时应用提交的权限", async () => {
    const db = getWebDb();
    authz.invalidateAuthzSnapshot();
    const cached = await authz.getAuthzSnapshot();
    expect(cached.tree.readPolicy(F.parent).value).toBe("public");
    const readSnapshot = authz.loadFreshAuthzSnapshot;
    const spy = vi.spyOn(authz, "loadFreshAuthzSnapshot").mockImplementationOnce(async (tx) => {
      const snapshot = await readSnapshot(tx);
      // 用另一条连接在规则读取完成后提交新权限和正文，两个请求之间不主动清缓存。
      await db.transaction(async (writer) => {
        await writer.update(forums).set({ readPolicy: "members" }).where(eq(forums.id, F.parent));
        await writer
          .update(posts)
          .set({ bodyMd: "权限收紧后的正文" })
          .where(eq(posts.id, postId(102)));
      });
      return snapshot;
    });
    try {
      expect((await loadFeed(board(F.parent)))?.entries[0]?.bodyMd).toBe(PUBLIC_BODY);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(await authz.getAuthzSnapshot()).toBe(cached);
      expect(await loadFeed(board(F.parent))).toBeNull();
      expect(await isPublicFeedForum(F.parent)).toBe(false);
      expect((await loadFeed(latest))?.entries.map(({ id }) => id)).not.toContain(102);
    } finally {
      spy.mockRestore();
      await db.update(forums).set({ readPolicy: "inherit" }).where(eq(forums.id, F.parent));
      await db
        .update(posts)
        .set({ bodyMd: PUBLIC_BODY })
        .where(eq(posts.id, postId(102)));
    }
  });
});
