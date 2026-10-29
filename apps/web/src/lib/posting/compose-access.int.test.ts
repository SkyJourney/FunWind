// @vitest-environment node
/**
 * 发帖/回帖可用性加载（M6 以来的 compose-access.ts 此前 0 覆盖，M9.5 补齐）：
 * 临时库覆盖 guest/会员、分区、归档、锁定帖的分支与展示文案口径。
 */
import "@/modules";
import { eq } from "drizzle-orm";
import { forums, getWebDb } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSubject } from "@/lib/authz/subject";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { DEMO } from "@funwind/db";
import { loadComposeAccess, loadReplyAccess } from "./compose-access";

let tdb: TempDb;
const REVIEW_FORUM = 906; // seed：review_policy=all
const ARCHIVED_FORUM = 905; // seed：unlistedForum（is_listed=0，未归档）
const MEMBER_FORUM = 901; // seed：普通可写板块

beforeAll(async () => {
  tdb = await setupTempDb();
  // 造一个归档板块
  await getWebDb().update(forums).set({ isArchived: true }).where(eq(forums.id, ARCHIVED_FORUM));
});

afterAll(async () => {
  await tdb?.teardown();
});

describe.skipIf(skipDb)("compose-access 加载（M9.5 补覆盖）", () => {
  it("游客 + 普通板块：closed + 登录引导", async () => {
    const guest = await loadSubject(null);
    const a = await loadComposeAccess(guest, MEMBER_FORUM, "forum");
    expect(a).toMatchObject({ mode: "closed", loginHref: "/login" });
    expect(a.mode === "closed" && a.text).toContain("登录");
  });

  it("分区不可发帖：closed + 分区文案", async () => {
    const member = await loadSubject(DEMO.member);
    const a = await loadComposeAccess(member, 900, "section");
    expect(a.mode).toBe("closed");
    expect(a.mode === "closed" && a.text).toContain("分区");
  });

  it("归档板块：会员被拒（归档文案）", async () => {
    const member = await loadSubject(DEMO.member);
    const a = await loadComposeAccess(member, ARCHIVED_FORUM, "forum");
    expect(a.mode).toBe("closed");
    expect(a.mode === "closed" && a.text).toContain("归档");
  });

  it("会员在普通板块可发帖；在 all 审核板块带待审提示（reviewHint）", async () => {
    const member = await loadSubject(DEMO.member);
    const ok = await loadComposeAccess(member, MEMBER_FORUM, "forum");
    expect(ok).toEqual({ mode: "form", reviewHint: false });
    const review = await loadComposeAccess(member, REVIEW_FORUM, "forum");
    expect(review).toEqual({ mode: "form", reviewHint: true });
  });

  it("回复可用性：普通帖可回；锁定帖对普通会员拒绝（locked 文案）", async () => {
    const member = await loadSubject(DEMO.member);
    const open = await loadReplyAccess(member, MEMBER_FORUM, false);
    expect(open.mode).toBe("form");
    const locked = await loadReplyAccess(member, MEMBER_FORUM, true);
    expect(locked.mode).toBe("closed");
    expect(locked.mode === "closed" && locked.text).toContain("锁定");
  });
});
