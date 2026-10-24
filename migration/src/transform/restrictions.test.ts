import { describe, expect, it } from "vitest";
import { GROUP_MUTE_ID_BASE, transformRestrictions, type OldBan } from "./restrictions.js";

const ASOF = "2026-10-23 00:00:00";
const unix = (s: string) => Math.floor(new Date(`${s.replace(" ", "T")}+08:00`).getTime() / 1000);
const users = new Set([1, 2, 3, 4]);

const ban = (over: Partial<OldBan> & { id: number; uid: number }): OldBan => ({
  typeid: 1,
  fid: 0,
  end_time: 0,
  created_userid: 9,
  created_time: unix("2018-11-01 12:00:00"),
  reason: "违规",
  ...over,
});

describe("transformRestrictions · 旧封禁", () => {
  it("typeid 1/2/4 → 禁言/禁头像/禁签名；永久封禁 ends_at 为空；保留旧 id", () => {
    const r = transformRestrictions(
      [
        ban({ id: 10, uid: 1, typeid: 1 }),
        ban({ id: 11, uid: 1, typeid: 2 }),
        ban({ id: 12, uid: 1, typeid: 4 }),
      ],
      [],
      users,
      ASOF,
    );
    expect(r.rows.map((x) => [x.id, x.kind, x.endsAt])).toEqual([
      [10, "mute", null],
      [11, "no_avatar", null],
      [12, "no_signature", null],
    ]);
    expect(r.rows[0]).toMatchObject({
      userId: 1,
      scopeId: 0,
      createdBy: 9,
      startsAt: "2018-11-01 12:00:00",
      reason: "违规",
    });
  });

  it("已过期的丢弃，尚未过期的保留；基准时间固定，结果可重复", () => {
    const rows = [
      ban({ id: 1, uid: 1, end_time: unix("2019-01-01 00:00:00") }),
      ban({ id: 2, uid: 2, end_time: unix("2030-01-01 00:00:00") }),
    ];
    const a = transformRestrictions(rows, [], users, ASOF);
    expect(a.rows.map((x) => x.id)).toEqual([2]);
    expect(a.stats.expiredSkipped).toBe(1);
    expect(a.rows[0]?.endsAt).toBe("2030-01-01 00:00:00");
    expect(transformRestrictions(rows, [], users, ASOF)).toEqual(a);
  });

  it("未知类型、已不存在的用户被跳过并计数", () => {
    const r = transformRestrictions(
      [ban({ id: 1, uid: 1, typeid: 3 }), ban({ id: 2, uid: 99 })],
      [],
      users,
      ASOF,
    );
    expect(r.rows).toEqual([]);
    expect(r.stats).toMatchObject({ unknownType: 1, orphanUsers: 1 });
  });

  it("版块级封禁带 scope_id；缺失创建时间回退基准时间；原因截断到 255", () => {
    const r = transformRestrictions(
      [
        ban({
          id: 1,
          uid: 1,
          fid: 53,
          created_time: 0,
          reason: "x".repeat(300),
          created_userid: 0,
        }),
      ],
      [],
      users,
      ASOF,
    );
    expect(r.rows[0]).toMatchObject({ scopeId: 53, startsAt: ASOF, createdBy: null });
    expect(r.rows[0]?.reason).toHaveLength(255);
  });
});

describe("transformRestrictions · 禁止发言组", () => {
  it("组成员 → 永久禁言，id 为确定性偏移", () => {
    const r = transformRestrictions([], [{ uid: 3, endtime: 0 }], users, ASOF);
    expect(r.rows).toEqual([
      expect.objectContaining({
        id: GROUP_MUTE_ID_BASE + 3,
        userId: 3,
        kind: "mute",
        endsAt: null,
        reason: "旧站「禁止发言」用户组",
      }),
    ]);
    expect(r.stats.fromGroup).toBe(1);
  });

  it("已有生效禁言的用户不重复派生；禁头像不算禁言", () => {
    const r = transformRestrictions(
      [ban({ id: 1, uid: 1, typeid: 1 }), ban({ id: 2, uid: 2, typeid: 2 })],
      [
        { uid: 1, endtime: 0 },
        { uid: 2, endtime: 0 },
      ],
      users,
      ASOF,
    );
    expect(r.stats.groupDeduped).toBe(1);
    expect(
      r.rows
        .filter((x) => x.kind === "mute")
        .map((x) => x.userId)
        .sort(),
    ).toEqual([1, 2]);
  });

  it("主组与附加组重复出现只算一次；过期附加组与不存在用户跳过", () => {
    const r = transformRestrictions(
      [],
      [
        { uid: 4, endtime: 0 },
        { uid: 4, endtime: unix("2030-01-01 00:00:00") },
        { uid: 2, endtime: unix("2019-01-01 00:00:00") },
        { uid: 99, endtime: 0 },
      ],
      users,
      ASOF,
    );
    expect(r.rows.map((x) => x.userId)).toEqual([4]);
    expect(r.stats).toMatchObject({ expiredSkipped: 1, orphanUsers: 1 });
  });

  it("带到期时间的附加组 → 有 ends_at 的禁言", () => {
    const r = transformRestrictions(
      [],
      [{ uid: 1, endtime: unix("2030-06-01 08:00:00") }],
      users,
      ASOF,
    );
    expect(r.rows[0]?.endsAt).toBe("2030-06-01 08:00:00");
  });
});
