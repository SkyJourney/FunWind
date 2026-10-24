import { describe, expect, it } from "vitest";
import {
  transformConversations,
  transformFollows,
  transformPolls,
  transformReactions,
} from "./social.js";

const ASOF = "2026-10-23 00:00:00";
const T = 1_300_000_000;
const users = new Set([1, 2, 3, 4]);

describe("transformFollows", () => {
  it("关注用户与加入版块；无效引用、自关注、重复分别计数", () => {
    const r = transformFollows(
      [
        { uid: 1, touid: 2, created_time: T },
        { uid: 1, touid: 2, created_time: T },
        { uid: 1, touid: 1, created_time: T },
        { uid: 1, touid: 99, created_time: T },
      ],
      [
        { uid: 3, fid: 10, join_time: T },
        { uid: 3, fid: 404, join_time: T },
      ],
      users,
      new Set([10]),
      ASOF,
    );
    expect(r.rows.map((x) => [x.userId, x.targetType, x.targetId])).toEqual([
      [1, "user", 2],
      [3, "forum", 10],
    ]);
    expect(r.stats).toEqual({ users: 1, forums: 1, invalid: 2, self: 1, duplicate: 1 });
  });

  it("缺失时间回退基准时间", () => {
    const r = transformFollows([{ uid: 1, touid: 2, created_time: 0 }], [], users, new Set(), ASOF);
    expect(r.rows[0]?.createdAt).toBe(ASOF);
  });
});

describe("transformReactions", () => {
  it("主题点赞落在首帖，回帖点赞落在回帖；孤儿与重复丢弃", () => {
    const r = transformReactions(
      [
        { uid: 1, created_time: T, typeid: 1, fromid: 5 },
        { uid: 2, created_time: T, typeid: 2, fromid: 30 },
        { uid: 2, created_time: T, typeid: 2, fromid: 30 },
        { uid: 99, created_time: T, typeid: 2, fromid: 30 },
        { uid: 3, created_time: T, typeid: 1, fromid: 404 },
      ],
      new Set([5005, 30]),
      new Map([[5, 5005]]),
      users,
      ASOF,
    );
    expect(r.rows.map((x) => [x.userId, x.postId])).toEqual([
      [1, 5005],
      [2, 30],
    ]);
    expect(r.stats).toEqual({ thread: 1, post: 1, orphan: 2, duplicate: 1 });
  });
});

describe("transformPolls", () => {
  const polls = [
    {
      poll_id: 1,
      tid: 10,
      voter_num: 99,
      option_limit: 0,
      isafter_view: 1,
      expired_time: 0,
      created_userid: 1,
      created_time: 0,
    },
    {
      poll_id: 2,
      tid: null,
      voter_num: 0,
      option_limit: 2,
      isafter_view: 0,
      expired_time: T,
      created_userid: 1,
      created_time: T,
    },
    {
      poll_id: 3,
      tid: 404,
      voter_num: 0,
      option_limit: 1,
      isafter_view: 0,
      expired_time: 0,
      created_userid: 1,
      created_time: T,
    },
    {
      poll_id: 4,
      tid: 10,
      voter_num: 0,
      option_limit: 1,
      isafter_view: 0,
      expired_time: 0,
      created_userid: 1,
      created_time: T,
    },
  ];
  const options = [
    { option_id: 11, poll_id: 1, content: "甲" },
    { option_id: 12, poll_id: 1, content: "乙" },
    { option_id: 21, poll_id: 2, content: "无主题" },
  ];

  it("无主题/主题不存在/同主题重复的投票丢弃；设置映射；缺失创建时间回退基准", () => {
    const r = transformPolls(polls, options, [], new Set([10]), users, ASOF);
    expect(r.polls).toEqual([
      expect.objectContaining({
        id: 1,
        threadId: 10,
        optionLimit: 1,
        resultVisibility: "after_vote",
        endsAt: null,
        createdAt: ASOF,
      }),
    ]);
    expect(r.options.map((o) => [o.id, o.sortOrder])).toEqual([
      [11, 0],
      [12, 1],
    ]);
    expect(r.stats).toMatchObject({
      droppedNoThread: 2,
      droppedDuplicateThread: 1,
      optionsDropped: 1,
    });
  });

  it("计数以实际投票记录重算（旧 voter_num 有偏差）；无效/重复投票丢弃", () => {
    const r = transformPolls(
      polls,
      options,
      [
        { uid: 1, poll_id: 1, option_id: 11, created_time: T },
        { uid: 1, poll_id: 1, option_id: 12, created_time: T },
        { uid: 2, poll_id: 1, option_id: 11, created_time: T },
        { uid: 2, poll_id: 1, option_id: 11, created_time: T },
        { uid: 99, poll_id: 1, option_id: 11, created_time: T },
        { uid: 3, poll_id: 1, option_id: 21, created_time: T },
      ],
      new Set([10]),
      users,
      ASOF,
      new Map([[1, 99]]),
    );
    expect(r.polls[0]?.voterCount).toBe(2);
    expect(r.options.map((o) => o.voteCount)).toEqual([2, 1]);
    expect(r.stats).toMatchObject({
      votesKept: 3,
      votesDuplicate: 1,
      votesInvalid: 2,
      voterCountCorrected: 1,
    });
  });
});

describe("transformConversations", () => {
  const convert = (s: string) => s.trim();
  const msg = (id: number, from: number, to: number, t: number, content = `m${id}`) => ({
    message_id: id,
    from_uid: from,
    to_uid: to,
    content,
    created_time: T + t,
  });

  it("系统消息(uid 0)、用户不存在(含已删除的虚拟账号 uid 1)、自发自收、空内容不进会话；真实用户对合并为单聊", () => {
    const r = transformConversations(
      [
        msg(1, 0, 2, 1),
        msg(2, 1, 2, 2),
        msg(3, 2, 99, 3),
        msg(4, 2, 2, 4),
        msg(5, 2, 3, 5),
        msg(6, 3, 2, 6),
        msg(7, 2, 3, 7, "   "),
      ],
      [],
      new Set([2, 3, 4]), // uid 1 在旧站用户表里不存在（已删除的虚拟账号）
      convert,
      ASOF,
    );
    expect(r.conversations).toEqual([
      { id: 1, pairKey: "2:3", lastMessageAt: expect.any(String), createdAt: expect.any(String) },
    ]);
    expect(r.messages.map((m) => [m.id, m.senderId])).toEqual([
      [5, 2],
      [6, 3],
    ]);
    expect(r.stats).toMatchObject({
      systemDropped: 1,
      orphanUser: 2,
      self: 1,
      emptyDropped: 1,
      messages: 2,
    });
  });

  it("会话 id 与成员确定性；A→B 与 B→A 合并到同一会话", () => {
    const rows = [msg(1, 3, 2, 1), msg(2, 1, 4, 2), msg(3, 2, 3, 3)];
    const a = transformConversations(rows, [], users, convert, ASOF);
    expect(a.conversations.map((c) => [c.id, c.pairKey])).toEqual([
      [1, "1:4"],
      [2, "2:3"],
    ]);
    expect(a.members).toHaveLength(4);
    expect(transformConversations([...rows].reverse(), [], users, convert, ASOF)).toEqual(a);
  });

  it("未读状态还原：按对端发来的消息倒数；无未读记录视为已读；全部未读为 null", () => {
    const rows = [msg(1, 3, 2, 1), msg(2, 3, 2, 2), msg(3, 3, 2, 3), msg(4, 2, 3, 4)];
    const r = transformConversations(
      rows,
      [
        { from_uid: 2, to_uid: 3, unread_count: 1 }, // 用户 2 有 1 条未读 → 已读到第 2 条
        { from_uid: 3, to_uid: 2, unread_count: 0 },
      ],
      users,
      convert,
      ASOF,
    );
    const by = new Map(r.members.map((m) => [m.userId, m.lastReadMessageId]));
    expect(by.get(2)).toBe(2);
    expect(by.get(3)).toBe(4);
    const allUnread = transformConversations(
      rows,
      [{ from_uid: 2, to_uid: 3, unread_count: 3 }],
      users,
      convert,
      ASOF,
    );
    expect(allUnread.members.find((m) => m.userId === 2)?.lastReadMessageId).toBeNull();
    expect(allUnread.stats.withUnread).toBe(1);
  });
});
