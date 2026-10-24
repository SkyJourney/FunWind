import { describe, expect, it } from "vitest";
import type { ContentState } from "@/lib/authz/evaluator";
import { counterDelta, type CounterDelta, type TransitionFacts } from "./counters";

const STATES: ContentState[] = ["visible", "pending", "rejected", "hidden", "deleted"];
const facts = (over: Partial<TransitionFacts> = {}): TransitionFacts => ({
  kind: "reply",
  before: null,
  after: "visible",
  threadVisible: true,
  visibleReplies: 0,
  isFeatured: false,
  isLatest: true,
  ...over,
});
const ZERO: CounterDelta = {
  thread: { replyCount: 0 },
  forum: { threadCount: 0, postCount: 0 },
  author: { threadCount: 0, postCount: 0, featuredCount: 0 },
  pointers: { thread: "none", forum: "none", author: "none" },
};
/** 取相反数；0 保持 +0（toEqual 会区分 +0 与 -0） */
const neg = (n: number): number => (n === 0 ? 0 : -n);
const negate = (d: CounterDelta): CounterDelta => ({
  thread: { replyCount: neg(d.thread.replyCount) },
  forum: { threadCount: neg(d.forum.threadCount), postCount: neg(d.forum.postCount) },
  author: {
    threadCount: neg(d.author.threadCount),
    postCount: neg(d.author.postCount),
    featuredCount: neg(d.author.featuredCount),
  },
  pointers: d.pointers,
});
const nums = (d: CounterDelta) => ({ ...d, pointers: undefined });

describe("只有 可见 ↔ 不可见 的跨越才改计数", () => {
  it("可见 → 可见（编辑）、不可见之间互转、创建为待审：全部零增量，指针不动", () => {
    for (const kind of ["thread", "reply"] as const)
      for (const before of [null, ...STATES] as const)
        for (const after of STATES) {
          const bothInvisible = before !== "visible" && after !== "visible";
          const bothVisible = before === "visible" && after === "visible";
          if (!bothInvisible && !bothVisible) continue;
          expect(
            counterDelta(facts({ kind, before, after })),
            `${kind} ${before}→${after}`,
          ).toEqual(ZERO);
        }
  });

  it("变可见与变不可见互为相反数（数值部分）——对每个 kind、每种辅助事实", () => {
    for (const kind of ["thread", "reply"] as const)
      for (const threadVisible of [true, false])
        for (const visibleReplies of [0, 3])
          for (const isFeatured of [true, false]) {
            const f = { kind, threadVisible, visibleReplies, isFeatured };
            const gain = counterDelta(facts({ ...f, before: "pending", after: "visible" }));
            const loss = counterDelta(facts({ ...f, before: "visible", after: "deleted" }));
            expect(nums(loss), JSON.stringify(f)).toEqual(nums(negate(gain)));
          }
  });
});

describe("回帖（reply）", () => {
  it("新回帖直接可见：主题 +1、版块帖数 +1、作者帖数 +1；不碰主题数；指针前移", () => {
    expect(counterDelta(facts({ before: null, after: "visible" }))).toEqual({
      thread: { replyCount: 1 },
      forum: { threadCount: 0, postCount: 1 },
      author: { threadCount: 0, postCount: 1, featuredCount: 0 },
      pointers: { thread: "advance", forum: "recompute", author: "recompute" },
    });
  });

  it("所属主题不可见：版块 post_count 与版块指针不动，但主题 reply_count 与作者 post_count 照常变（口径不对称）", () => {
    const d = counterDelta(facts({ before: null, after: "visible", threadVisible: false }));
    expect(d.forum).toEqual({ threadCount: 0, postCount: 0 });
    expect(d.pointers.forum).toBe("none");
    expect(d.thread.replyCount).toBe(1);
    expect(d.author.postCount).toBe(1);
  });

  it("变不可见（软删 / 隐藏 / 驳回…）：反向，且指针一律回查", () => {
    for (const after of ["deleted", "hidden", "rejected", "pending"] as const) {
      const d = counterDelta(facts({ before: "visible", after, isLatest: true }));
      expect(d.thread.replyCount, after).toBe(-1);
      expect(d.pointers, after).toEqual({
        thread: "recompute",
        forum: "recompute",
        author: "recompute",
      });
    }
  });

  it("恢复 / 审核通过一条旧帖（不是最新楼层）：计数 +1，但指针必须回查而不是前移", () => {
    for (const before of ["deleted", "hidden", "pending"] as const) {
      const d = counterDelta(facts({ before, after: "visible", isLatest: false }));
      expect(d.thread.replyCount, before).toBe(1);
      expect(d.pointers.thread, before).toBe("recompute");
    }
    // 对照：恢复的恰好是最新楼层 → 可前移
    expect(
      counterDelta(facts({ before: "deleted", after: "visible", isLatest: true })).pointers.thread,
    ).toBe("advance");
  });

  it("回帖永远不改任何「主题数」计数，也不动精华数", () => {
    for (const before of [null, ...STATES] as const)
      for (const after of STATES) {
        const d = counterDelta(facts({ before, after, isFeatured: true, visibleReplies: 9 }));
        expect(d.forum.threadCount).toBe(0);
        expect(d.author.threadCount).toBe(0);
        expect(d.author.featuredCount).toBe(0);
      }
  });
});

describe("主题（thread，首帖同步）", () => {
  it("新主题直接可见（无回帖）：版块主题 +1、帖数 +1；作者主题 +1、帖数 +1；主题自己的 reply_count 不动", () => {
    expect(counterDelta(facts({ kind: "thread", before: null, after: "visible" }))).toEqual({
      thread: { replyCount: 0 },
      forum: { threadCount: 1, postCount: 1 },
      author: { threadCount: 1, postCount: 1, featuredCount: 0 },
      pointers: { thread: "advance", forum: "recompute", author: "recompute" },
    });
  });

  it("删除一个有 N 条可见回帖的主题：版块帖数整体减 1+N，作者只减自己的首帖——回帖作者的计数不变", () => {
    const d = counterDelta(
      facts({ kind: "thread", before: "visible", after: "deleted", visibleReplies: 4 }),
    );
    expect(d.forum).toEqual({ threadCount: -1, postCount: -5 });
    expect(d.author).toEqual({ threadCount: -1, postCount: -1, featuredCount: 0 });
    expect(d.thread.replyCount).toBe(0);
  });

  it("恢复同一个主题：版块帖数加回 1+N（对称）", () => {
    const d = counterDelta(
      facts({
        kind: "thread",
        before: "deleted",
        after: "visible",
        visibleReplies: 4,
        isLatest: false,
      }),
    );
    expect(d.forum).toEqual({ threadCount: 1, postCount: 5 });
    expect(d.pointers).toEqual({ thread: "recompute", forum: "recompute", author: "recompute" });
  });

  it("精华主题：作者 featured_count 随可见性加减；非精华不动", () => {
    expect(
      counterDelta(facts({ kind: "thread", before: "visible", after: "hidden", isFeatured: true }))
        .author.featuredCount,
    ).toBe(-1);
    expect(
      counterDelta(facts({ kind: "thread", before: "hidden", after: "visible", isFeatured: true }))
        .author.featuredCount,
    ).toBe(1);
    expect(
      counterDelta(facts({ kind: "thread", before: "visible", after: "hidden", isFeatured: false }))
        .author.featuredCount,
    ).toBe(0);
  });

  it("主题迁移忽略 threadVisible（主题自己就是被迁移的对象）", () => {
    const a = counterDelta(
      facts({ kind: "thread", before: null, after: "visible", threadVisible: true }),
    );
    const b = counterDelta(
      facts({ kind: "thread", before: null, after: "visible", threadVisible: false }),
    );
    expect(a).toEqual(b);
  });
});

describe("不会改动入参", () => {
  it("零增量返回的是新对象，调用方修改它不会污染后续结果", () => {
    const a = counterDelta(facts({ before: "visible", after: "visible" }));
    a.thread.replyCount = 99;
    expect(counterDelta(facts({ before: "visible", after: "visible" })).thread.replyCount).toBe(0);
  });
});
