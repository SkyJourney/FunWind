import { describe, expect, it } from "vitest";
import {
  legacyAvatarKey,
  normalizeKey,
  transformUsers,
  type OldUser,
  type UserTransformOptions,
} from "./users.js";

const u = (over: Partial<OldUser> & { uid: number }): OldUser => ({
  username: `user${over.uid}`,
  email_u: null,
  email_w: null,
  regdate: 1_300_000_000,
  lastvisit: 1_400_000_000,
  gender: 0,
  location_text: "",
  homepage: "",
  bbs_sign: null,
  profile: null,
  byear: null,
  bmonth: null,
  bday: null,
  ...over,
});

const opts: UserTransformOptions = {
  spamUids: new Set<number>(),
  firstActivity: new Map<number, string>(),
  avatarExists: () => false,
  convertSignature: (s: string) => s.toUpperCase(),
  fallbackCreatedAt: "2010-01-01 00:00:00",
};
const run = (rows: OldUser[], o: Partial<typeof opts> = {}) =>
  transformUsers(rows, { ...opts, ...o });

describe("normalizeKey / 头像路径", () => {
  it("归一化只做 trim + 小写，不做 NFKC（半角假名不与全角合并）", () => {
    expect(normalizeKey("  Alice ")).toBe("alice");
    expect(normalizeKey("さくら")).not.toBe(normalizeKey("サクラ"));
    expect(normalizeKey("ｻｸﾗ")).not.toBe(normalizeKey("サクラ"));
  });

  it("旧站头像算法（与 web 侧实证样本一致）", () => {
    expect(legacyAvatarKey(25940)).toBe("avatar/000/02/59/25940.jpg");
    expect(legacyAvatarKey(20709)).toBe("avatar/000/02/07/20709.jpg");
    expect(legacyAvatarKey(1)).toBe("avatar/000/00/00/1.jpg");
    expect(legacyAvatarKey(1_234_567)).toBe("avatar/001/23/45/1234567.jpg");
  });
});

describe("transformUsers · 身份", () => {
  it("基础映射：密码置空、未验证邮箱、最近登录", () => {
    const r = run([u({ uid: 1, username: " Alice ", email_u: "A@X.io" })]);
    expect(r.users[0]).toEqual({
      id: 1,
      username: "Alice",
      usernameKey: "alice",
      email: "A@X.io",
      emailKey: "a@x.io",
      passwordHash: null,
      emailVerifiedAt: null,
      state: "active",
      createdAt: "2011-03-13 15:06:40",
      lastLoginAt: "2014-05-14 00:53:20",
    });
  });

  it("windid 邮箱优先于 nw_user 邮箱", () => {
    const r = run([u({ uid: 1, email_u: "old@x.io", email_w: "new@x.io" })]);
    expect(r.users[0]?.email).toBe("new@x.io");
  });

  it("用户名归一化冲突：后者追加 _uid，并记录", () => {
    const r = run([u({ uid: 1, username: "Foo" }), u({ uid: 2, username: "foo" })]);
    expect(r.users.map((x) => x.username)).toEqual(["Foo", "foo_2"]);
    expect(r.notes.usernameCollisions).toEqual([{ uid: 2, from: "foo", to: "foo_2" }]);
    expect(new Set(r.users.map((x) => x.usernameKey)).size).toBe(2);
  });

  it("平假名/片假名/半角假名互不冲突（旧站 EUC-JP 实测红线）", () => {
    const r = run([
      u({ uid: 1, username: "さくら" }),
      u({ uid: 2, username: "サクラ" }),
      u({ uid: 3, username: "ｻｸﾗ" }),
    ]);
    expect(r.notes.usernameCollisions).toEqual([]);
  });

  it("空用户名补 user{uid}", () => {
    const r = run([u({ uid: 9, username: "  " })]);
    expect(r.users[0]?.username).toBe("user9");
    expect(r.notes.emptyUsernames).toEqual([9]);
  });

  it("spam 用户标记", () => {
    const r = run([u({ uid: 1 }), u({ uid: 2 })], { spamUids: new Set([2]) });
    expect(r.users.map((x) => x.state)).toEqual(["active", "spam"]);
    expect(r.notes.spam).toBe(1);
  });
});

describe("transformUsers · 邮箱", () => {
  it("非法邮箱置空并记录（含单引号等）", () => {
    const r = run([u({ uid: 1, email_u: "bad'mail@x.io" }), u({ uid: 2, email_u: "nope" })]);
    expect(r.users.map((x) => x.email)).toEqual([null, null]);
    expect(r.notes.invalidEmails.map((e) => e.uid)).toEqual([1, 2]);
  });

  it("重复邮箱（大小写不敏感）：保留注册最早者，其余置空并记录", () => {
    const r = run([
      u({ uid: 10, email_u: "dup@x.io", regdate: 1_500_000_000 }),
      u({ uid: 11, email_u: "DUP@x.io", regdate: 1_300_000_000 }),
      u({ uid: 12, email_u: "dup@x.io", regdate: 1_400_000_000 }),
    ]);
    const by = new Map(r.users.map((x) => [x.id, x]));
    expect(by.get(11)?.email).toBe("DUP@x.io");
    expect(by.get(10)?.email).toBeNull();
    expect(by.get(12)?.emailKey).toBeNull();
    expect(r.notes.duplicateEmails).toEqual([
      { email: "dup@x.io", keptUid: 11, clearedUids: [12, 10] },
    ]);
  });

  it("注册时间相同则 uid 小者保留；regdate=0 的排在最后", () => {
    const same = run([
      u({ uid: 2, email_u: "a@x.io", regdate: 1_300_000_000 }),
      u({ uid: 1, email_u: "a@x.io", regdate: 1_300_000_000 }),
    ]);
    expect(same.notes.duplicateEmails[0]?.keptUid).toBe(1);
    const zero = run([
      u({ uid: 1, email_u: "a@x.io", regdate: 0 }),
      u({ uid: 2, email_u: "a@x.io", regdate: 1_300_000_000 }),
    ]);
    expect(zero.notes.duplicateEmails[0]?.keptUid).toBe(2);
  });
});

describe("transformUsers · 注册时间修复（regdate=0）", () => {
  it("依次回退：最早发帖时间 → 最近访问 → 兜底常量，并记录来源", () => {
    const r = run(
      [
        u({ uid: 1, regdate: 0 }),
        u({ uid: 2, regdate: 0 }),
        u({ uid: 3, regdate: 0, lastvisit: 0 }),
      ],
      { firstActivity: new Map([[1, "2012-02-02 10:00:00"]]) },
    );
    const by = new Map(r.users.map((x) => [x.id, x.createdAt]));
    expect(by.get(1)).toBe("2012-02-02 10:00:00");
    expect(by.get(2)).toBe("2014-05-14 00:53:20");
    expect(by.get(3)).toBe("2010-01-01 00:00:00");
    expect(r.notes.createdAtRepaired.map((x) => x.source)).toEqual([
      "activity",
      "lastvisit",
      "fallback",
    ]);
  });
});

describe("transformUsers · 资料", () => {
  it("字段映射、签名转换、头像", () => {
    const r = run(
      [
        u({
          uid: 5,
          gender: 2,
          location_text: "东京",
          homepage: "http://a.io",
          profile: "简介",
          bbs_sign: "sig",
        }),
      ],
      { avatarExists: (uid) => uid === 5 },
    );
    expect(r.profiles[0]).toEqual({
      userId: 5,
      bio: "简介",
      location: "东京",
      website: "http://a.io",
      gender: 2,
      birthday: null,
      signatureMd: "SIG",
      avatarKey: "avatar/000/00/00/5.jpg",
    });
    expect(r.notes.avatars).toBe(1);
  });

  it("性别异常值归零；空字段为 null/空串", () => {
    const r = run([u({ uid: 1, gender: 9, bbs_sign: "" })]);
    expect(r.profiles[0]).toMatchObject({
      gender: 0,
      bio: null,
      signatureMd: null,
      avatarKey: null,
    });
  });

  it("生日：合法日期保留；非法/缺失为 null", () => {
    const ok = run([u({ uid: 1, byear: 1990, bmonth: 2, bday: 28 })]);
    expect(ok.profiles[0]?.birthday).toBe("1990-02-28");
    for (const [y, m, d] of [
      [1990, 2, 30],
      [1800, 1, 1],
      [2090, 1, 1],
      [1990, 13, 1],
      [0, 0, 0],
      [null, null, null],
    ] as const) {
      const r = run([u({ uid: 1, byear: y, bmonth: m, bday: d })]);
      expect(r.profiles[0]?.birthday, `${y}-${m}-${d}`).toBeNull();
    }
  });
});
