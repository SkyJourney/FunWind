import { toDatetime } from "../config.js";

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
  firstPostOf: ReadonlyMap<number, number>,
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
    const postId =
      Number(l.typeid) === 1 ? (firstPostOf.get(Number(l.fromid)) ?? 0) : Number(l.fromid);
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
