import type { ContentState } from "@/lib/authz/evaluator";

/**
 * 内容状态迁移带来的缓存计数变化（M6.1，纯函数；设计稿 §3）。
 *
 * 口径与迁移的计数重算 SQL 完全一致（那份 SQL 将抽成共享的 recountAll，增量结果必须等于它）：
 *  · threads.reply_count          = 主题里 floor>1 的可见帖数（与主题自己是否可见无关）
 *  · forums.thread_count          = 版块里可见主题数
 *  · forums.post_count            = 版块里**可见主题**下的可见帖数（含首帖）
 *  · user_stats.thread_count      = 作者名下可见主题数；featured_count 为其中精华数
 *  · user_stats.post_count        = 作者名下可见帖数（含首帖），**不看所属主题**
 * 因此有一处不对称：删一个主题时，版块 post_count 要减掉该主题全部可见帖，而回帖作者的 post_count 不变。
 *
 * 只有「可见 ↔ 不可见」的跨越会改计数；pending / rejected / hidden / deleted 之间互转、可见 → 可见（编辑）都是零增量。
 * 「最后一帖」类指针：只有主题指针可以在"变可见且是主题最新楼层"时前移（advance）；版块与作者指针一律回查（recompute），
 * 因为恢复的旧帖可能早于它们当前最新的活动。其余情形（删除最后一帖…）都回查。
 */

export type Pointer = "none" | "advance" | "recompute";

export interface TransitionFacts {
  /** thread = 主题（首帖与主题状态同事务同步）；reply = 回帖 */
  kind: "thread" | "reply";
  /** 迁移前的状态；创建时为 null */
  before: ContentState | null;
  after: ContentState;
  /** reply 迁移：所属主题此刻是否可见（决定版块 post_count 是否受影响）。thread 迁移忽略 */
  threadVisible: boolean;
  /** thread 迁移：该主题除首帖外此刻的可见回帖数（版块 post_count 要整体加减） */
  visibleReplies: number;
  /** thread 迁移：是否精华（作者 featured_count 随可见性加减） */
  isFeatured: boolean;
  /** 本帖是不是该主题里最新的可见楼层（迁移后）；为 true 且是"变可见"时指针可直接前移 */
  isLatest: boolean;
}

export interface CounterDelta {
  /** 作用于所属主题 */
  thread: { replyCount: number };
  /** 作用于所属版块 */
  forum: { threadCount: number; postCount: number };
  /** 作用于该帖作者的 user_stats */
  author: { threadCount: number; postCount: number; featuredCount: number };
  pointers: {
    /** threads.last_post_id / last_poster_id / last_posted_at */
    thread: Pointer;
    /** forums.last_post_id / last_posted_at */
    forum: Pointer;
    /** user_stats.last_post_at */
    author: Pointer;
  };
}

const ZERO: CounterDelta = {
  thread: { replyCount: 0 },
  forum: { threadCount: 0, postCount: 0 },
  author: { threadCount: 0, postCount: 0, featuredCount: 0 },
  pointers: { thread: "none", forum: "none", author: "none" },
};

export const isVisible = (s: ContentState | null): boolean => s === "visible";

export function counterDelta(f: TransitionFacts): CounterDelta {
  const was = isVisible(f.before);
  const now = isVisible(f.after);
  if (was === now) return structuredClone(ZERO);

  const sign = now ? 1 : -1;
  const gain = now;
  /** 变可见且是最新楼层 → 前移；其余（变不可见、恢复旧帖）→ 回查 */
  const ptr: Pointer = gain && f.isLatest ? "advance" : "recompute";

  if (f.kind === "reply") {
    return {
      thread: { replyCount: sign },
      forum: { threadCount: 0, postCount: f.threadVisible ? sign : 0 },
      author: { threadCount: 0, postCount: sign, featuredCount: 0 },
      pointers: {
        thread: ptr,
        // 版块 / 作者指针一律回查，不做前移：恢复一条旧帖时，它可能早于版块或作者当前最新的活动
        // （旧实现在这里前移，会把版块指向一条更旧的帖子；oracle 集成测试 transition.int.test.ts 抓到过）。
        // 主题不可见时它不参与版块的"最后活跃"，版块指针不动。
        forum: f.threadVisible ? "recompute" : "none",
        author: "recompute",
      },
    };
  }

  // 主题：首帖状态与主题状态同步，主题整体进出版块
  return {
    thread: { replyCount: 0 },
    forum: { threadCount: sign, postCount: sign * (1 + f.visibleReplies) },
    author: { threadCount: sign, postCount: sign, featuredCount: f.isFeatured ? sign : 0 },
    // 版块 / 作者同理回查（见上面 reply 分支的说明）
    pointers: { thread: ptr, forum: "recompute", author: "recompute" },
  };
}
