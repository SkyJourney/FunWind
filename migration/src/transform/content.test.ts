import { describe, expect, it } from "vitest";
import {
  noteAuthor,
  stateOf,
  transformAttachments,
  transformContent,
  transformTags,
  transformUnlocks,
  type ContentContext,
  type GateRow,
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
  it("首帖 = floor 1，id 接在全部旧 pid 之后按 tid 升序自增；回帖保留旧 pid，楼层从 2 起", () => {
    const r = transformContent(
      [thread({ tid: 9 }), thread({ tid: 5 })],
      [
        post({ pid: 30, tid: 5, created_time: T0 + 200 }),
        post({ pid: 20, tid: 5, created_time: T0 + 100 }),
      ],
      ctx(),
    );
    expect(r.threads.map((t) => [t.id, t.firstPostId])).toEqual([
      [5, 31],
      [9, 32],
    ]);
    expect(r.firstPostOf).toEqual(
      new Map([
        [5, 31],
        [9, 32],
      ]),
    );
    expect(r.posts.map((p) => [p.id, p.threadId, p.floor])).toEqual([
      [20, 5, 2],
      [30, 5, 3],
      [31, 5, 1],
      [32, 9, 1],
    ]);
    expect(r.posts.find((p) => p.id === 31)).toMatchObject({
      authorId: 1,
      bodyMd: "首帖正文",
      replyToPostId: null,
    });
  });

  it("首帖 id 与过滤结果无关：最大旧 pid 取自全部旧帖（含不迁移的）", () => {
    const r = transformContent(
      [thread({ tid: 1 })],
      [post({ pid: 500, tid: 1, disabled: 2 })],
      ctx(),
    );
    expect(r.threads[0]?.firstPostId).toBe(501);
    expect(r.posts.map((p) => p.id)).toEqual([501]);
  });

  it("楼层按 (created_time, pid) 稳定排序：同一秒用 pid 打破平局", () => {
    const r = transformContent(
      [thread({ tid: 1 })],
      [post({ pid: 9, tid: 1 }), post({ pid: 3, tid: 1 })],
      ctx(),
    );
    expect(r.posts.filter((p) => p.floor > 1).map((p) => p.id)).toEqual([3, 9]);
  });

  it("只迁可见内容：回收站/屏蔽主题、空壳、版块不存在、无作者的主题都不迁，分别计数", () => {
    const r = transformContent(
      [
        thread({ tid: 1 }),
        thread({ tid: 2, disabled: 2 }),
        thread({ tid: 3, ifshield: 1 }),
        thread({ tid: 4, content: null, has_content: 0 }),
        thread({ tid: 5, fid: 999 }),
        thread({ tid: 6, created_userid: 0 }),
      ],
      [],
      ctx({ spamTids: new Set([4]) }),
    );
    expect(r.threads.map((t) => t.id)).toEqual([1]);
    expect(r.stats.threadsDropped).toEqual({
      deleted: 1,
      hidden: 1,
      spamShell: 1,
      badForum: [5],
      noAuthor: 1,
    });
  });

  it("只迁可见回帖；主题未迁移的回帖记为孤儿，其余按状态/无作者计数", () => {
    const r = transformContent(
      [thread({ tid: 1 }), thread({ tid: 2, disabled: 2 })],
      [
        post({ pid: 1, tid: 1 }),
        post({ pid: 2, tid: 1, disabled: 2 }),
        post({ pid: 3, tid: 1, ifshield: 1 }),
        post({ pid: 4, tid: 1, created_userid: 0 }),
        post({ pid: 5, tid: 2 }),
        post({ pid: 6, tid: 999 }),
        post({ pid: 7, tid: 0 }),
      ],
      ctx(),
    );
    expect(r.posts.filter((p) => p.floor > 1).map((p) => p.id)).toEqual([1]);
    expect(r.stats.postsDropped).toEqual({ orphan: 3, deleted: 1, hidden: 1, noAuthor: 1 });
  });

  it("楼层在丢弃之后保持连续（不留空洞）", () => {
    const r = transformContent(
      [thread({ tid: 1 })],
      [
        post({ pid: 1, tid: 1, created_time: T0 + 1 }),
        post({ pid: 2, tid: 1, created_time: T0 + 2, disabled: 2 }),
        post({ pid: 3, tid: 1, created_time: T0 + 3 }),
      ],
      ctx(),
    );
    expect(
      r.posts
        .filter((p) => p.threadId === 1)
        .map((p) => p.floor)
        .sort(),
    ).toEqual([1, 2, 3]);
  });

  it("无正文但有回复的主题：补空首帖并记录", () => {
    const r = transformContent(
      [thread({ tid: 2, content: null, has_content: 0 })],
      [post({ pid: 1, tid: 2 })],
      ctx(),
    );
    expect(r.posts.find((p) => p.floor === 1)).toMatchObject({ bodyMd: "" });
    expect(r.stats.emptyFirstPosts).toEqual([2]);
  });

  it("回复指针：同主题保留；跨主题、悬空、指向未迁移的帖置空并分别计数", () => {
    const r = transformContent(
      [thread({ tid: 1 }), thread({ tid: 2 })],
      [
        post({ pid: 10, tid: 1 }),
        post({ pid: 11, tid: 1, rpid: 10 }),
        post({ pid: 12, tid: 1, rpid: 20 }),
        post({ pid: 20, tid: 2 }),
        post({ pid: 13, tid: 1, rpid: 9999 }),
        post({ pid: 14, tid: 1, rpid: 15 }),
        post({ pid: 15, tid: 1, disabled: 2 }),
      ],
      ctx(),
    );
    const by = new Map(r.posts.map((p) => [p.id, p.replyToPostId]));
    expect(by.get(11)).toBe(10);
    expect(by.get(12)).toBeNull();
    expect(by.get(13)).toBeNull();
    expect(by.get(14)).toBeNull();
    expect(r.stats.replyPointers).toEqual({ crossThread: 1, dangling: 1, droppedTarget: 1 });
  });

  it("作者不在 userIds：记入占位账号清单（取其最早内容时间）；存在的用户不记", () => {
    const r = transformContent(
      [thread({ tid: 1, created_userid: 999, created_time: T0 + 50 })],
      [
        post({ pid: 1, tid: 1, created_userid: 999, created_time: T0 + 10 }),
        post({ pid: 2, tid: 1, created_userid: 2 }),
      ],
      ctx(),
    );
    expect([...r.placeholders.keys()]).toEqual([999]);
    // 回帖（T0+10）早于主题（T0+50）：取较早者
    expect(r.placeholders.get(999)).toBe("2011-03-13 15:06:50");
  });

  it("置顶/精华/前缀/类型：topped→pinLevel（截断到 0–3），digest>0→精华", () => {
    const r = transformContent(
      [
        thread({
          tid: 1,
          topic_type: 7,
          special: "poll",
          subject: "  标题  ",
          hits: 42,
          topped: 3,
        }),
        thread({ tid: 2, topic_type: 8, topped: 9, digest: 2 }),
      ],
      [],
      ctx(),
    );
    expect(r.threads[0]).toMatchObject({
      prefixId: 7,
      kind: "poll",
      title: "标题",
      viewCount: 42,
      pinLevel: 3,
      isFeatured: false,
    });
    expect(r.threads[1]).toMatchObject({
      prefixId: null,
      kind: "normal",
      pinLevel: 3,
      isFeatured: true,
    });
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
    expect(by.get(3)).not.toBeNull(); // 首帖
    expect(by.get(1)).toBeNull();
    expect(by.get(2)).not.toBeNull();
  });

  it("noteAuthor：已有用户不记；重复记取较早时间", () => {
    const seen = new Map<number, string>();
    const users = new Set([1]);
    noteAuthor(seen, users, 1, "2011-01-01 00:00:00");
    noteAuthor(seen, users, 7, "2012-01-01 00:00:00");
    noteAuthor(seen, users, 7, "2011-06-01 00:00:00");
    noteAuthor(seen, users, 7, "2013-01-01 00:00:00");
    expect(seen).toEqual(new Map([[7, "2011-06-01 00:00:00"]]));
  });
});

describe("transformContent · 门控", () => {
  it("门控拆出：key = g{序号}，id 按 (帖子 id, 序号) 自增 1..n，隐藏内容不在公开正文里", () => {
    const r = transformContent(
      [thread({ tid: 3, content: "前文[sell=5,]付费秘密[/sell]后文[post]回复秘密[/post]" })],
      [post({ pid: 77, tid: 3, content: "[sell=2,]y[/sell]" })],
      ctx(),
    );
    expect(r.gates.map((g) => [g.id, g.postId, g.gateKey])).toEqual([
      [1, 77, "g1"],
      [2, 78, "g1"],
      [3, 78, "g2"],
    ]);
    expect(r.gates[1]?.conditions[0]).toEqual({ type: "points", price: 5 });
    expect(r.gates[2]?.conditions[0]).toEqual({ type: "reply" });
    const first = r.posts.find((p) => p.id === 78);
    expect(first?.hasGate).toBe(true);
    expect(first?.bodyMd).not.toContain("付费秘密");
    expect(first?.bodyMd).not.toContain("回复秘密");
    expect(r.stats.gates).toEqual({ points: 2, reply: 1 });
  });

  it("门控时间随所属帖子：创建=发帖时间，更新=编辑时间（无编辑则同创建）", () => {
    const r = transformContent(
      [thread({ tid: 1, content: "[sell=5,]x[/sell]", modified_time: T0 + 60 })],
      [post({ pid: 5, tid: 1, content: "[sell=1,]y[/sell]" })],
      ctx(),
    );
    const byPost = new Map(r.gates.map((g) => [g.postId, g]));
    expect(byPost.get(5)).toMatchObject({
      createdAt: "2011-03-13 15:08:20",
      updatedAt: "2011-03-13 15:08:20",
    });
    expect(byPost.get(6)?.createdAt).toBe("2011-03-13 15:06:40");
    expect(byPost.get(6)?.updatedAt).toBe("2011-03-13 15:07:40");
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

  it("表情展开与遗留表情码删除；颜色字号等样式降级计入告警", () => {
    const r = transformContent(
      [thread({ tid: 1, content: "好[s:130]看[s:171][color=red]红字[/color]" })],
      [],
      ctx(),
    );
    expect(r.posts[0]?.bodyMd).toBe("好![表情](/emoji/130.gif)看红字");
    expect(r.stats.warnings.get("emoji-legacy-stripped")).toBe(1);
    expect(r.stats.warnings.get("style-degraded")).toBe(1);
  });
});

describe("transformUnlocks", () => {
  const gate = (id: number, postId: number, type: "points" | "reply"): GateRow => ({
    id,
    postId,
    gateKey: "g1",
    conditions: [type === "points" ? { type, price: 5 } : { type }],
    matchMode: "all",
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
  const FIRST = 900;
  const firstPostOf = new Map([[1, FIRST]]);
  const run = (buys: ReturnType<typeof buy>[], gates = [gate(1, FIRST, "points")]) =>
    transformUnlocks(buys, gates, new Set([FIRST, 50]), firstPostOf, new Set([1, 2]), ASOF);

  it("pid=0 → 首帖；pid>0 → 该回帖；保留价格与时间，不带来源标记", () => {
    const r = run([buy({})]);
    expect(r.rows).toEqual([
      { gateId: 1, userId: 1, pricePaid: 5, authorIncome: 5, unlockedAt: expect.any(String) },
    ]);
    const reply = transformUnlocks(
      [buy({ pid: 50 })],
      [gate(801, 50, "points")],
      new Set([FIRST, 50]),
      firstPostOf,
      new Set([1]),
      ASOF,
    );
    expect(reply.rows[0]?.gateId).toBe(801);
  });

  it("一帖多个积分门控：一次购买展开成每个门控各一条", () => {
    const gates = [gate(1, FIRST, "points"), gate(2, FIRST, "points")];
    expect(run([buy({})], gates).rows.map((r) => r.gateId)).toEqual([1, 2]);
  });

  it("只有回复可见门控的购买不生成解锁；无门控、孤儿购买者/目标、重复分别计数", () => {
    const replyOnly = run([buy({})], [gate(9, FIRST, "reply")]);
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
  const FIRST = 900;
  const run = (rows: ReturnType<typeof att>[]) =>
    transformAttachments(
      rows as never,
      new Set([FIRST, 50]),
      new Map([[1, FIRST]]),
      new Map([
        [FIRST, 1],
        [50, 2],
      ]),
      ASOF,
    );

  it("挂到所属回帖；pid=0 挂首帖；记下旧站路径与下载数（文件本体交文件管线）", () => {
    const r = run([att({}), att({ aid: 2, pid: 50, name: "a.JPG", path: "Mon_1/a.jpg" })]);
    expect(r.rows[0]).toEqual({
      postId: FIRST,
      uploaderId: 1,
      originalName: "字幕.zip",
      sourcePath: "1302/thread/a.zip",
      downloads: 3,
      createdAt: expect.any(String),
    });
    expect(r.rows[1]).toMatchObject({ postId: 50, sourcePath: "Mon_1/a.jpg" });
  });

  it("回帖未迁移改挂首帖；主题未迁移则丢弃；上传者缺失记为所挂帖的作者", () => {
    const r = run([
      att({ aid: 3, pid: 777 }),
      att({ aid: 4, tid: 404 }),
      att({ aid: 5, created_userid: 0 }),
    ]);
    expect(r.rows.map((x) => x.postId)).toEqual([FIRST, FIRST]);
    expect(r.rows[1]?.uploaderId).toBe(1);
    expect(r.stats).toEqual({ orphan: 1, reattachedToFirstPost: 1, uploaderFromPostAuthor: 1 });
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
