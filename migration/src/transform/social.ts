import { toDatetime } from "../config.js";
import { firstPostId } from "./content.js";

// ---------- 关注 ----------

export interface FollowRow {
  userId: number;
  targetType: "user" | "forum";
  targetId: number;
  createdAt: string;
}

/** 关注用户（nw_attention）+ 加入版块（nw_bbs_forum_user）；引用已不存在的用户/版块、自关注一律丢弃 */
export function transformFollows(
  attention: readonly { uid: number; touid: number; created_time: number }[],
  joins: readonly { uid: number; fid: number; join_time: number }[],
  userIds: ReadonlySet<number>,
  forumIds: ReadonlySet<number>,
  asOf: string,
): {
  rows: FollowRow[];
  stats: { users: number; forums: number; invalid: number; self: number; duplicate: number };
} {
  const stats = { users: 0, forums: 0, invalid: 0, self: 0, duplicate: 0 };
  const seen = new Set<string>();
  const rows: FollowRow[] = [];
  const add = (r: FollowRow) => {
    const k = `${r.userId}:${r.targetType}:${r.targetId}`;
    if (seen.has(k)) {
      stats.duplicate++;
      return false;
    }
    seen.add(k);
    rows.push(r);
    return true;
  };
  for (const a of attention) {
    const [u, t] = [Number(a.uid), Number(a.touid)];
    if (!userIds.has(u) || !userIds.has(t)) {
      stats.invalid++;
      continue;
    }
    if (u === t) {
      stats.self++;
      continue;
    }
    if (
      add({
        userId: u,
        targetType: "user",
        targetId: t,
        createdAt: toDatetime(Number(a.created_time)) ?? asOf,
      })
    )
      stats.users++;
  }
  for (const j of joins) {
    const [u, f] = [Number(j.uid), Number(j.fid)];
    if (!userIds.has(u) || !forumIds.has(f)) {
      stats.invalid++;
      continue;
    }
    if (
      add({
        userId: u,
        targetType: "forum",
        targetId: f,
        createdAt: toDatetime(Number(j.join_time)) ?? asOf,
      })
    )
      stats.forums++;
  }
  return { rows, stats };
}

// ---------- 点赞 ----------

export interface ReactionRow {
  userId: number;
  postId: number;
  kind: "like";
  createdAt: string;
}

/** typeid 1 = 主题（点赞落在首帖），2 = 回帖；以明细为准，计数之后重算 */
export function transformReactions(
  likes: readonly { uid: number; created_time: number; typeid: number; fromid: number }[],
  postIds: ReadonlySet<number>,
  userIds: ReadonlySet<number>,
  asOf: string,
): {
  rows: ReactionRow[];
  stats: { thread: number; post: number; orphan: number; duplicate: number };
} {
  const stats = { thread: 0, post: 0, orphan: 0, duplicate: 0 };
  const seen = new Set<string>();
  const rows: ReactionRow[] = [];
  for (const l of likes) {
    const uid = Number(l.uid);
    const postId = Number(l.typeid) === 1 ? firstPostId(Number(l.fromid)) : Number(l.fromid);
    if (!userIds.has(uid) || !postIds.has(postId)) {
      stats.orphan++;
      continue;
    }
    const k = `${uid}:${postId}`;
    if (seen.has(k)) {
      stats.duplicate++;
      continue;
    }
    seen.add(k);
    rows.push({
      userId: uid,
      postId,
      kind: "like",
      createdAt: toDatetime(Number(l.created_time)) ?? asOf,
    });
    if (Number(l.typeid) === 1) stats.thread++;
    else stats.post++;
  }
  return { rows, stats };
}

// ---------- 投票 ----------

export interface PollRow {
  id: number;
  threadId: number;
  optionLimit: number;
  endsAt: string | null;
  resultVisibility: "always" | "after_vote";
  voterCount: number;
  createdBy: number;
  createdAt: string;
}
export interface PollOptionRow {
  id: number;
  pollId: number;
  content: string;
  voteCount: number;
  sortOrder: number;
}
export interface PollVoteRow {
  pollId: number;
  optionId: number;
  userId: number;
  createdAt: string;
}

export interface PollsResult {
  polls: PollRow[];
  options: PollOptionRow[];
  votes: PollVoteRow[];
  stats: {
    polls: number;
    droppedNoThread: number;
    droppedDuplicateThread: number;
    optionsDropped: number;
    votesKept: number;
    votesInvalid: number;
    votesDuplicate: number;
    voterCountCorrected: number;
  };
}

/** 计数一律以实际投票记录重算（旧 voter_num / voted_num 有偏差） */
export function transformPolls(
  polls: readonly {
    poll_id: number;
    tid: number | null;
    option_limit: number;
    isafter_view: number;
    expired_time: number;
    created_userid: number;
    created_time: number;
  }[],
  options: readonly { option_id: number; poll_id: number; content: string }[],
  votes: readonly { uid: number; poll_id: number; option_id: number; created_time: number }[],
  threadIds: ReadonlySet<number>,
  userIds: ReadonlySet<number>,
  asOf: string,
  oldVoterNum: ReadonlyMap<number, number> = new Map(),
): PollsResult {
  const stats: PollsResult["stats"] = {
    polls: 0,
    droppedNoThread: 0,
    droppedDuplicateThread: 0,
    optionsDropped: 0,
    votesKept: 0,
    votesInvalid: 0,
    votesDuplicate: 0,
    voterCountCorrected: 0,
  };
  const usedThreads = new Set<number>();
  const keptPolls = new Map<number, PollRow>();
  for (const p of [...polls].sort((a, b) => Number(a.poll_id) - Number(b.poll_id))) {
    const tid = p.tid === null ? 0 : Number(p.tid);
    if (!tid || !threadIds.has(tid)) {
      stats.droppedNoThread++;
      continue;
    }
    if (usedThreads.has(tid)) {
      stats.droppedDuplicateThread++;
      continue;
    }
    usedThreads.add(tid);
    keptPolls.set(Number(p.poll_id), {
      id: Number(p.poll_id),
      threadId: tid,
      optionLimit: Math.max(1, Number(p.option_limit) || 1),
      endsAt: toDatetime(Number(p.expired_time)),
      resultVisibility: Number(p.isafter_view) > 0 ? "after_vote" : "always",
      voterCount: 0,
      createdBy: Number(p.created_userid) || 0,
      createdAt: toDatetime(Number(p.created_time)) ?? asOf,
    });
  }

  const optionsOut: PollOptionRow[] = [];
  const optionPoll = new Map<number, number>();
  const sortIndex = new Map<number, number>();
  for (const o of options) {
    const pollId = Number(o.poll_id);
    if (!keptPolls.has(pollId)) {
      stats.optionsDropped++;
      continue;
    }
    const idx = sortIndex.get(pollId) ?? 0;
    sortIndex.set(pollId, idx + 1);
    optionPoll.set(Number(o.option_id), pollId);
    optionsOut.push({
      id: Number(o.option_id),
      pollId,
      content: String(o.content ?? "").slice(0, 255),
      voteCount: 0,
      sortOrder: idx,
    });
  }
  const optionById = new Map(optionsOut.map((o) => [o.id, o]));

  const votesOut: PollVoteRow[] = [];
  const seen = new Set<string>();
  const voters = new Map<number, Set<number>>();
  for (const v of votes) {
    const [pollId, optionId, uid] = [Number(v.poll_id), Number(v.option_id), Number(v.uid)];
    if (!keptPolls.has(pollId) || optionPoll.get(optionId) !== pollId || !userIds.has(uid)) {
      stats.votesInvalid++;
      continue;
    }
    const k = `${pollId}:${optionId}:${uid}`;
    if (seen.has(k)) {
      stats.votesDuplicate++;
      continue;
    }
    seen.add(k);
    votesOut.push({
      pollId,
      optionId,
      userId: uid,
      createdAt: toDatetime(Number(v.created_time)) ?? asOf,
    });
    optionById.get(optionId)!.voteCount++;
    const s = voters.get(pollId) ?? new Set<number>();
    s.add(uid);
    voters.set(pollId, s);
    stats.votesKept++;
  }
  for (const p of keptPolls.values()) {
    p.voterCount = voters.get(p.id)?.size ?? 0;
    const old = oldVoterNum.get(p.id);
    if (old !== undefined && old !== p.voterCount) stats.voterCountCorrected++;
  }
  stats.polls = keptPolls.size;
  return { polls: [...keptPolls.values()], options: optionsOut, votes: votesOut, stats };
}

// ---------- 私信 ----------

export interface ConversationRow {
  id: number;
  pairKey: string;
  lastMessageAt: string;
  createdAt: string;
}
export interface MemberRow {
  conversationId: number;
  userId: number;
  lastReadMessageId: number | null;
}
export interface MessageRow {
  id: number;
  conversationId: number;
  senderId: number;
  body: string;
  createdAt: string;
}

export interface ConversationsResult {
  conversations: ConversationRow[];
  members: MemberRow[];
  messages: MessageRow[];
  stats: {
    messages: number;
    systemDropped: number;
    orphanUser: number;
    self: number;
    emptyDropped: number;
    withUnread: number;
  };
}

/**
 * 旧站私信：uid 0 是系统发信人（欢迎语、锁帖通知等 2,268 条）不进会话；
 * uid 1 是旧站已删除的虚拟账号（用户表里没有这一行），涉及它的 25 条真人对话按「用户已不存在」丢弃；
 * 真实用户间的消息按「用户对」合并为单聊会话。
 * 会话行的归属以 from_uid 为视角（owner）、to_uid 为对端；未读数据此还原 lastReadMessageId。
 */
export function transformConversations(
  messages: readonly {
    message_id: number;
    from_uid: number;
    to_uid: number;
    content: string;
    created_time: number;
  }[],
  dialogs: readonly { from_uid: number; to_uid: number; unread_count: number }[],
  userIds: ReadonlySet<number>,
  convert: (src: string) => string,
  asOf: string,
): ConversationsResult {
  const stats = {
    messages: 0,
    systemDropped: 0,
    orphanUser: 0,
    self: 0,
    emptyDropped: 0,
    withUnread: 0,
  };
  const byPair = new Map<string, (typeof messages)[number][]>();
  for (const m of [...messages].sort(
    (a, b) =>
      Number(a.created_time) - Number(b.created_time) ||
      Number(a.message_id) - Number(b.message_id),
  )) {
    const [f, t] = [Number(m.from_uid), Number(m.to_uid)];
    if (f === 0 || t === 0) {
      stats.systemDropped++;
      continue;
    }
    if (!userIds.has(f) || !userIds.has(t)) {
      stats.orphanUser++;
      continue;
    }
    if (f === t) {
      stats.self++;
      continue;
    }
    const key = `${Math.min(f, t)}:${Math.max(f, t)}`;
    const list = byPair.get(key) ?? [];
    list.push(m);
    byPair.set(key, list);
  }

  const unreadOf = new Map<string, number>(); // `${owner}>${peer}` → 未读数
  for (const d of dialogs)
    unreadOf.set(`${Number(d.from_uid)}>${Number(d.to_uid)}`, Number(d.unread_count) || 0);

  const conversations: ConversationRow[] = [];
  const members: MemberRow[] = [];
  const out: MessageRow[] = [];
  let id = 0;
  for (const key of [...byPair.keys()].sort((a, b) => {
    const [a1, a2] = a.split(":").map(Number) as [number, number];
    const [b1, b2] = b.split(":").map(Number) as [number, number];
    return a1 - b1 || a2 - b2;
  })) {
    const list = byPair.get(key)!;
    const [lo, hi] = key.split(":").map(Number) as [number, number];
    const kept: MessageRow[] = [];
    const convId = id + 1;
    for (const m of list) {
      const body = convert(String(m.content ?? "")).trim();
      if (!body) {
        stats.emptyDropped++;
        continue;
      }
      kept.push({
        id: Number(m.message_id),
        conversationId: convId,
        senderId: Number(m.from_uid),
        body,
        createdAt: toDatetime(Number(m.created_time)) ?? asOf,
      });
    }
    if (kept.length === 0) continue;
    id = convId;
    conversations.push({
      id: convId,
      pairKey: key,
      lastMessageAt: kept[kept.length - 1]!.createdAt,
      createdAt: kept[0]!.createdAt,
    });
    for (const [owner, peer] of [
      [lo, hi],
      [hi, lo],
    ] as const) {
      const unread = unreadOf.get(`${owner}>${peer}`);
      let lastRead: number | null;
      if (unread === undefined || unread <= 0) {
        lastRead = kept[kept.length - 1]!.id; // 没有未读记录：视为全部已读
      } else {
        const fromPeer = kept.filter((m) => m.senderId === peer);
        const readCount = fromPeer.length - unread;
        lastRead = readCount > 0 ? fromPeer[readCount - 1]!.id : null;
        stats.withUnread++;
      }
      members.push({ conversationId: convId, userId: owner, lastReadMessageId: lastRead });
    }
    out.push(...kept);
    stats.messages += kept.length;
  }
  return { conversations, members, messages: out, stats };
}
