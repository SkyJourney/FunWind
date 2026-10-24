import { describe, expect, it } from "vitest";
import { transformFollows, transformPolls, transformReactions } from "./social.js";

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
