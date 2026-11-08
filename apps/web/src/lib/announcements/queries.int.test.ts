// @vitest-environment node
/**
 * 公告展示页数据层集成测试（M13 追加功能）：/a/{id} 详情 + /a 归档列表。
 * 覆盖：受众过滤（游客看不到 members-only）、有效期（未开始/已结束不可见）、
 * 归档列表含已结束条目、已读标记（重复标记幂等）。
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getWebDb } from "@funwind/db";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import {
  getAnnouncement,
  isAnnouncementRead,
  listAnnouncements,
  markAnnouncementRead,
} from "./queries";

let tdb: TempDb | undefined;

async function insertAnnouncement(values: {
  title: string;
  audience?: "all" | "members";
  startsAt?: string;
  endsAt?: string | null;
  showBanner?: boolean;
}): Promise<number> {
  const db = getWebDb();
  const [row] = await db.execute(sql`
    INSERT INTO announcements
      (title, body_md, level, audience, show_banner, starts_at, ends_at, created_by, created_at, updated_at)
    VALUES (
      ${values.title}, '正文内容', 'info',
      ${values.audience ?? "all"},
      ${values.showBanner ?? false},
      ${values.startsAt ?? "2020-01-01 00:00:00"},
      ${values.endsAt === undefined ? null : values.endsAt},
      1, NOW(), NOW()
    )
  `);
  const id = Number((row as unknown as { insertId?: number }).insertId ?? 0);
  expect(id).toBeGreaterThan(0);
  return id;
}

beforeAll(async () => {
  tdb = await setupTempDb({ demo: false });
});

afterAll(async () => {
  await tdb?.teardown();
});

describe.skipIf(skipDb)("公告展示页数据层（M13 追加）", () => {
  it("all 类公告：游客与登录用户都能读到", async () => {
    const id = await insertAnnouncement({ title: "面向所有人的公告" });
    expect((await getAnnouncement(id, false))?.title).toBe("面向所有人的公告");
    expect((await getAnnouncement(id, true))?.title).toBe("面向所有人的公告");
  });

  it("members-only 公告：游客读不到（404 语义），登录用户可读", async () => {
    const id = await insertAnnouncement({ title: "仅会员公告", audience: "members" });
    expect(await getAnnouncement(id, false)).toBeNull();
    expect((await getAnnouncement(id, true))?.title).toBe("仅会员公告");
  });

  it("未开始 / 已结束的公告：详情页读不到（失效公告不做死链展示）", async () => {
    const future = await insertAnnouncement({
      title: "还没开始",
      startsAt: "2999-01-01 00:00:00",
    });
    expect(await getAnnouncement(future, true)).toBeNull();
    const past = await insertAnnouncement({
      title: "已经结束",
      startsAt: "2020-01-01 00:00:00",
      endsAt: "2020-02-01 00:00:00",
    });
    expect(await getAnnouncement(past, true)).toBeNull();
  });

  it("归档列表：含已结束条目（过期公告的归宿），并标注 active=false", async () => {
    await insertAnnouncement({ title: "进行中的公告" });
    await insertAnnouncement({
      title: "早已结束的公告",
      startsAt: "2020-01-01 00:00:00",
      endsAt: "2020-02-01 00:00:00",
    });
    const items = await listAnnouncements(true);
    const ended = items.find((i) => i.title === "早已结束的公告");
    expect(ended?.active).toBe(false);
    const active = items.find((i) => i.title === "进行中的公告");
    expect(active?.active).toBe(true);
  });

  it("归档列表：游客看不到 members-only 公告", async () => {
    await insertAnnouncement({ title: "仅会员的归档项", audience: "members" });
    const guestItems = await listAnnouncements(false);
    expect(guestItems.some((i) => i.title === "仅会员的归档项")).toBe(false);
    const memberItems = await listAnnouncements(true);
    expect(memberItems.some((i) => i.title === "仅会员的归档项")).toBe(true);
  });

  it("已读标记：游客恒未读；登录用户标记后为已读，重复标记幂等", async () => {
    const id = await insertAnnouncement({ title: "已读测试" });
    expect(await isAnnouncementRead(id, null)).toBe(false);
    expect(await isAnnouncementRead(id, 90001)).toBe(false);
    await markAnnouncementRead(id, 90001);
    expect(await isAnnouncementRead(id, 90001)).toBe(true);
    await markAnnouncementRead(id, 90001);
    expect(await isAnnouncementRead(id, 90001)).toBe(true);
  });
});
