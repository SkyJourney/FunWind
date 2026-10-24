import { describe, expect, it } from "vitest";
import {
  firstPostId,
  stateOf,
  transformAttachments,
  transformContent,
  transformTags,
  transformUnlocks,
  type ContentContext,
  type OldPost,
  type OldThread,
} from "./content.js";

const ASOF = "2026-10-23 00:00:00";
const T0 = 1_300_000_000; // 2011-03-13 15:06:40 (+08:00)

const thread = (over: Partial<OldThread> & { tid: number }): OldThread => ({
  fid: 10,
  topic_type: 0,
  subject: `主题${over.tid}`,
  digest: 0,
  topped: 0,
  special: "0",
  disabled: 0,
  ifshield: 0,
  hits: 5,
  created_time: T0,
  created_username: "alice",
  created_userid: 1,
  modified_time: 0,
  content: "首帖正文",
  has_content: 1,
  ...over,
});
const post = (over: Partial<OldPost> & { pid: number; tid: number }): OldPost => ({
  rpid: 0,
  disabled: 0,
  ifshield: 0,
  content: `回帖${over.pid}`,
  created_time: T0 + 100,
  created_username: "bob",
  created_userid: 2,
  modified_time: 0,
  ...over,
});
const ctx = (over: Partial<ContentContext> = {}): ContentContext => ({
  userIds: new Set([1, 2]),
  forumIds: new Set([10, 20]),
  prefixIds: new Set([7]),
  spamTids: new Set(),
  emojiIds: new Set([130]),
  resolveUpload: () => null,
  resolveAttachment: () => null,
  asOf: ASOF,
  ...over,
});

describe("stateOf", () => {
  it("回收站(disabled>0) → deleted，优先于屏蔽；屏蔽 → hidden；其余可见", () => {
    expect(stateOf(2, 0)).toBe("deleted");
    expect(stateOf(2, 1)).toBe("deleted");
    expect(stateOf(0, 1)).toBe("hidden");
    expect(stateOf(0, 0)).toBe("visible");
  });
});

describe("transformContent · 统一 post 模型", () => {
  it("首帖 = floor 1，post id = 100000 + tid；回帖保留旧 pid，楼层从 2 起", () => {
    const r = transformContent(
      [thread({ tid: 5 })],
      [
        post({ pid: 30, tid: 5, created_time: T0 + 200 }),
        post({ pid: 20, tid: 5, created_time: T0 + 100 }),
      ],
      ctx(),
    );
    expect(r.threads[0]).toMatchObject({
      id: 5,
      firstPostId: firstPostId(5),
      forumId: 10,
      state: "visible",
    });
    expect(r.posts.map((p) => [p.id, p.floor])).toEqual([
      [100005, 1],
      [20, 2],
      [30, 3],
    ]);
    expect(r.posts[0]).toMatchObject({
      threadId: 5,
      authorId: 1,
      bodyMd: "首帖正文",
      replyToPostId: null,
    });
  });

  it("楼层按 (created_time, pid) 稳定排序：同一秒用 pid 打破平局", () => {
    const r = transformContent(
      [thread({ tid: 1 })],
      [post({ pid: 9, tid: 1 }), post({ pid: 3, tid: 1 })],
      ctx(),
    );
    expect(r.posts.filter((p) => p.floor > 1).map((p) => p.id)).toEqual([3, 9]);
  });

  it("空壳主题 → state=spam，不生成首帖与帖子", () => {
    const r = transformContent(
      [thread({ tid: 7, content: null, has_content: 0 })],
      [],
      ctx({ spamTids: new Set([7]) }),
    );
    expect(r.threads[0]).toMatchObject({ state: "spam", firstPostId: null });
    expect(r.posts).toEqual([]);
    expect(r.stats.spamThreads).toBe(1);
  });

  it("无正文但有回复的主题：补空首帖并记录", () => {
    const r = transformContent(
      [thread({ tid: 2, content: null, has_content: 0 })],
      [post({ pid: 1, tid: 2 })],
      ctx(),
    );
    expect(r.posts[0]).toMatchObject({ id: 100002, bodyMd: "", floor: 1 });
    expect(r.stats.emptyFirstPosts).toEqual([2]);
  });

  it("孤儿回帖（主题不存在 / 属于空壳主题）丢弃并计数", () => {
    const r = transformContent(
      [thread({ tid: 7, content: null, has_content: 0 })],
      [post({ pid: 1, tid: 999 }), post({ pid: 2, tid: 0 }), post({ pid: 3, tid: 7 })],
      ctx({ spamTids: new Set([7]) }),
    );
    expect(r.posts).toEqual([]);
    expect(r.stats.orphanPosts).toBe(3);
  });

  it("状态：回收站 → deleted，屏蔽 → hidden；首帖状态随主题", () => {
    const r = transformContent(
      [thread({ tid: 1, disabled: 2 }), thread({ tid: 2, ifshield: 1 })],
      [post({ pid: 1, tid: 2, disabled: 2 }), post({ pid: 2, tid: 2, ifshield: 1 })],
      ctx(),
    );
    const by = new Map(r.posts.map((p) => [p.id, p.state]));
    expect(by.get(100001)).toBe("deleted");
    expect(by.get(100002)).toBe("hidden");
    expect(by.get(1)).toBe("deleted");
    expect(by.get(2)).toBe("hidden");
    expect(r.threads.map((t) => t.state)).toEqual(["deleted", "hidden"]);
  });

  it("回复指针：同主题保留；跨主题、悬空置空并分别计数", () => {
    const r = transformContent(
      [thread({ tid: 1 }), thread({ tid: 2 })],
      [
        post({ pid: 10, tid: 1 }),
        post({ pid: 11, tid: 1, rpid: 10 }),
        post({ pid: 12, tid: 1, rpid: 20 }),
        post({ pid: 20, tid: 2 }),
        post({ pid: 13, tid: 1, rpid: 9999 }),
      ],
      ctx(),
    );
    const by = new Map(r.posts.map((p) => [p.id, p.replyToPostId]));
    expect(by.get(11)).toBe(10);
    expect(by.get(12)).toBeNull();
    expect(by.get(13)).toBeNull();
    expect(r.stats).toMatchObject({ crossThreadReplyPointers: 1, danglingReplyPointers: 1 });
  });

  it("作者已注销：保留旧用户名到 author_name_legacy；存在的用户为 null", () => {
    const r = transformContent(
      [thread({ tid: 1, created_userid: 999, created_username: " user-d " })],
      [post({ pid: 1, tid: 1, created_userid: 2 })],
      ctx(),
    );
    expect(r.threads[0]).toMatchObject({ authorId: 999, authorNameLegacy: "user-d" });
    expect(r.posts.find((p) => p.id === 1)?.authorNameLegacy).toBeNull();
  });

  it("前缀只保留被引用的；special=poll → kind=poll；标题与浏览数", () => {
    const r = transformContent(
      [
        thread({ tid: 1, topic_type: 7, special: "poll", subject: "  标题  ", hits: 42 }),
        thread({ tid: 2, topic_type: 8 }),
      ],
      [],
      ctx(),
    );
    expect(r.threads[0]).toMatchObject({ prefixId: 7, kind: "poll", title: "标题", viewCount: 42 });
    expect(r.threads[1]).toMatchObject({ prefixId: null, kind: "normal" });
  });

  it("版块已删除：有归档版块则改挂（内容保留），否则丢弃", () => {
    const rows = [thread({ tid: 1, fid: 999 }), thread({ tid: 2, fid: 0 })];
    const kept = transformContent(rows, [], ctx({ fallbackForumId: 20 }));
    expect(kept.threads.map((t) => t.forumId)).toEqual([20, 20]);
    expect(kept.stats.reassignedThreads).toEqual([
      { tid: 1, fromForum: 999 },
      { tid: 2, fromForum: 0 },
    ]);
    const dropped = transformContent(rows, [], ctx());
    expect(dropped.threads).toEqual([]);
    expect(dropped.stats.droppedThreadsBadForum).toEqual([1, 2]);
  });

  it("编辑时间：晚于创建才记录", () => {
    const r = transformContent(
      [thread({ tid: 1, modified_time: T0 + 60 })],
      [
        post({ pid: 1, tid: 1, modified_time: T0 }),
        post({ pid: 2, tid: 1, modified_time: T0 + 9999 }),
      ],
      ctx(),
    );
    const by = new Map(r.posts.map((p) => [p.id, p.editedAt]));
    expect(by.get(100001)).not.toBeNull();
    expect(by.get(1)).toBeNull();
    expect(by.get(2)).not.toBeNull();
  });
});

describe("transformContent · 门控", () => {
  it("门控拆出：正文只留占位，gate id = 帖子 id × 16 + seq，隐藏内容不在公开正文里", () => {
    const r = transformContent(
      [thread({ tid: 3, content: "前文[sell=5,]付费秘密[/sell]后文[post]回复秘密[/post]" })],
      [],
      ctx(),
    );
    const fp = firstPostId(3);
    expect(r.gates.map((g) => [g.id, g.seq, g.conditions[0]])).toEqual([
      [fp * 16 + 1, 1, { type: "points", price: 5 }],
      [fp * 16 + 2, 2, { type: "reply" }],
    ]);
    expect(r.posts[0]?.hasGate).toBe(true);
    expect(r.posts[0]?.bodyMd).not.toContain("付费秘密");
    expect(r.posts[0]?.bodyMd).not.toContain("回复秘密");
    expect(r.stats.gates).toEqual({ points: 1, reply: 1 });
  });

  it("回帖里的门控同样拆出；告警明细带帖子 id", () => {
    const r = transformContent(
      [thread({ tid: 1 })],
      [post({ pid: 77, tid: 1, content: "[sell=99999]x[/sell][sell=3,]y" })],
      ctx(),
    );
    expect(r.gates.map((g) => g.postId)).toEqual([77, 77]);
    expect(r.stats.priceReset).toEqual([{ postId: 77, price: "99999" }]);
    expect(r.stats.unclosedGates).toEqual([{ postId: 77, tag: "SELL" }]);
  });

  it("引用内的门控被丢弃并记录位置", () => {
    const r = transformContent(
      [thread({ tid: 1 })],
      [post({ pid: 5, tid: 1, content: "[quote][post]被引用[/post][/quote]" })],
      ctx(),
    );
    expect(r.gates).toEqual([]);
    expect(r.stats.nestedDropped).toEqual([{ postId: 5, detail: "POST in QUOTE" }]);
  });

  it("表情展开与遗留表情码删除", () => {
    const r = transformContent([thread({ tid: 1, content: "好[s:130]看[s:171]" })], [], ctx());
    expect(r.posts[0]?.bodyMd).toBe("好![表情](/emoji/130.gif)看");
    expect(r.stats.warnings.get("emoji-legacy-stripped")).toBe(1);
  });
});

describe("transformUnlocks", () => {
  const gate = (id: number, postId: number, type: "points" | "reply") => ({
    id,
    postId,
    seq: 1,
    conditions: [type === "points" ? { type, price: 5 } : { type }],
    matchMode: "all" as const,
    hiddenMd: "x",
    createdAt: ASOF,
    updatedAt: ASOF,
  });
  const buy = (over: Record<string, number>) => ({
    tid: 1,
    pid: 0,
    created_userid: 1,
    created_time: T0,
    cost: 5,
    ...over,
  });
  const run = (
    buys: ReturnType<typeof buy>[],
    gates = [gate(1_600_001, firstPostId(1), "points")],
  ) => transformUnlocks(buys, gates, new Set([firstPostId(1), 50]), new Set([1, 2]), ASOF);

  it("pid=0 → 首帖；pid>0 → 该回帖；保留价格与时间，来源 migrated", () => {
    const r = run([buy({})]);
    expect(r.rows).toEqual([
      expect.objectContaining({
        gateId: 1_600_001,
        userId: 1,
        pricePaid: 5,
        authorIncome: 5,
        source: "migrated",
      }),
    ]);
    const reply = transformUnlocks(
      [buy({ pid: 50 })],
      [gate(801, 50, "points")],
      new Set([firstPostId(1), 50]),
      new Set([1]),
      ASOF,
    );
    expect(reply.rows[0]?.gateId).toBe(801);
  });

  it("一帖多个积分门控：一次购买展开成每个门控各一条", () => {
    const gates = [gate(1, firstPostId(1), "points"), gate(2, firstPostId(1), "points")];
    expect(run([buy({})], gates).rows.map((r) => r.gateId)).toEqual([1, 2]);
  });

  it("只有回复可见门控的购买（旧站把回复解锁也记入购买表）不生成解锁；无门控、孤儿购买者、重复分别计数", () => {
    const replyOnly = run([buy({})], [gate(9, firstPostId(1), "reply")]);
    expect(replyOnly.rows).toEqual([]);
    expect(replyOnly.stats.replyOnly).toBe(1);
    const noGate = run([buy({})], []);
    expect(noGate.stats.noGate).toBe(1);
    const mixed = run([buy({ created_userid: 99 }), buy({ tid: 404 }), buy({}), buy({})]);
    expect(mixed.stats).toMatchObject({ orphanBuyer: 1, orphanTarget: 1, duplicate: 1 });
    expect(mixed.rows).toHaveLength(1);
  });
});

describe("transformAttachments", () => {
  const att = (over: Record<string, unknown>) => ({
    aid: 1,
    tid: 1,
    pid: 0,
    name: "字幕.zip",
    type: "zip",
    size: 26,
    hits: 3,
    width: 0,
    height: 0,
    path: "1302/thread/a.zip",
    created_userid: 1,
    created_time: T0,
    ...over,
  });
  const run = (rows: ReturnType<typeof att>[]) =>
    transformAttachments(rows as never, new Set([firstPostId(1), 50]), ASOF);

  it("挂到所属回帖；pid=0 挂首帖；记下旧站路径与下载数（文件本体交文件管线）", () => {
    const r = run([att({}), att({ aid: 2, pid: 50, name: "a.JPG", path: "Mon_1/a.jpg" })]);
    expect(r.rows[0]).toEqual({
      postId: firstPostId(1),
      uploaderId: 1,
      originalName: "字幕.zip",
      sourcePath: "1302/thread/a.zip",
      downloads: 3,
      createdAt: expect.any(String),
    });
    expect(r.rows[1]).toMatchObject({ postId: 50, sourcePath: "Mon_1/a.jpg" });
  });

  it("回帖已不存在改挂首帖；主题不存在则丢弃", () => {
    const r = run([att({ aid: 3, pid: 777 }), att({ aid: 4, tid: 404 })]);
    expect(r.rows.map((x) => x.postId)).toEqual([firstPostId(1)]);
    expect(r.stats).toEqual({ orphan: 1, reattachedToFirstPost: 1 });
  });
});

describe("transformTags", () => {
  it("空名/重复名丢弃；只保留主题标签关联；孤儿与重复关联丢弃", () => {
    const r = transformTags(
      [
        { tag_id: 1, tag_name: " 动画 " },
        { tag_id: 2, tag_name: "" },
        { tag_id: 3, tag_name: "动画" },
        { tag_id: 4, tag_name: "日剧" },
      ],
      [
        { tag_id: 1, param_id: 10, type_id: 1 },
        { tag_id: 1, param_id: 10, type_id: 1 },
        { tag_id: 4, param_id: 999, type_id: 1 },
        { tag_id: 4, param_id: 10, type_id: 2 },
        { tag_id: 3, param_id: 10, type_id: 1 },
      ],
      new Set([10]),
    );
    expect(r.tags).toEqual([
      { id: 1, name: "动画" },
      { id: 4, name: "日剧" },
    ]);
    expect(r.threadTags).toEqual([{ threadId: 10, tagId: 1 }]);
    expect(r.stats).toEqual({ emptyOrDuplicate: 2, orphanRelations: 3 });
  });
});
