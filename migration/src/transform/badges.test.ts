import { describe, expect, it } from "vitest";
import { TEAM_BADGE_ID_BASE, transformBadges } from "./badges.js";

const ASOF = "2026-10-23 00:00:00";
const unix = (s: string) => Math.floor(new Date(`${s.replace(" ", "T")}+08:00`).getTime() / 1000);
const users = new Set([1, 2, 3]);
const medals = [
  {
    medal_id: 44,
    name: " 社区居民 ",
    image: "m/44.png",
    icon: null,
    descrip: "欢迎",
    isopen: 1,
    vieworder: 2,
  },
  {
    medal_id: 46,
    name: "最爱沙发",
    image: null,
    icon: "m/46.gif",
    descrip: null,
    isopen: 0,
    vieworder: 1,
  },
];

describe("transformBadges", () => {
  it("旧勋章 → honor 徽章（key=medal-N，保留 id，名称 trim，图标取 image 否则 icon）", () => {
    const r = transformBadges(medals, [], [], users, ASOF);
    expect(r.badges.filter((b) => b.kind === "honor")).toEqual([
      expect.objectContaining({
        id: 44,
        key: "medal-44",
        name: "社区居民",
        iconSource: "m/44.png",
        isActive: true,
      }),
      expect.objectContaining({
        id: 46,
        key: "medal-46",
        iconSource: "m/46.gif",
        description: "",
        isActive: false,
      }),
    ]);
  });

  it("持有关系：CSV 展开成行；未知勋章、不存在的用户计数后跳过；重复只算一次", () => {
    const r = transformBadges(
      medals,
      [
        { uid: 1, medals: "44, 46,44", expired_time: 0 },
        { uid: 2, medals: "99", expired_time: 0 },
        { uid: 77, medals: "44", expired_time: 0 },
      ],
      [],
      users,
      ASOF,
    );
    expect(r.userBadges.map((u) => [u.userId, u.badgeId])).toEqual([
      [1, 44],
      [1, 46],
    ]);
    expect(r.stats).toMatchObject({ holdings: 3, unknownMedalRefs: 1, orphanUsers: 1 });
  });

  it("已过期的持有（如注册 3 天有效的欢迎勋章）跳过；未到期的保留到期时间", () => {
    const r = transformBadges(
      medals,
      [
        { uid: 1, medals: "44", expired_time: unix("2014-08-13 15:21:10") },
        { uid: 2, medals: "44", expired_time: unix("2030-01-01 00:00:00") },
      ],
      [],
      users,
      ASOF,
    );
    expect(r.userBadges).toEqual([
      { userId: 2, badgeId: 44, awardedAt: ASOF, expiresAt: "2030-01-01 00:00:00" },
    ]);
    expect(r.stats.expiredSkipped).toBe(1);
  });

  it("团队徽章：每个团队角色一枚（稳定 id），由角色持有人派生；管理员角色不产生徽章", () => {
    const r = transformBadges(
      [],
      [],
      [
        { userId: 1, roleKey: "team-subtitle" },
        { userId: 2, roleKey: "team-intern" },
        { userId: 3, roleKey: "admin" },
      ],
      users,
      ASOF,
    );
    const team = r.badges.filter((b) => b.kind === "team");
    expect(team).toHaveLength(6);
    expect(team.every((b) => b.id > TEAM_BADGE_ID_BASE)).toBe(true);
    expect(r.userBadges).toHaveLength(2);
    expect(r.stats.teamHoldings).toBe(2);
    const subtitle = team.find((b) => b.key === "team-subtitle");
    expect(r.userBadges.find((u) => u.userId === 1)?.badgeId).toBe(subtitle?.id);
  });
});
