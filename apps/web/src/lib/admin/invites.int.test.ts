// @vitest-environment node
/**
 * 邀请码管理集成测试（M10.6b）：批量生成（有效期/批次/审计）、列表状态机（可用/已用/过期）、
 * 撤销保护（已用不可撤销）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, getWebDb, inviteCodes } from "@funwind/db";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { generateInvites, listInvites, revokeInvite } from "./invites";

let tdb: TempDb;
const ACTOR = { userId: 90004, ip: "127.0.0.1" };

beforeAll(async () => {
  tdb = await setupTempDb({ demo: true });
});

afterAll(() => {
  tdb?.teardown();
});

describe.skipIf(skipDb)("邀请码管理（M10.6b）", () => {
  it("批量生成：码面格式、有效期、审计落库", async () => {
    const r = await generateInvites(ACTOR, { count: 3, days: 30, batch: "it-批次" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.codes).toHaveLength(3);
    for (const c of r.codes)
      expect(c).toMatch(
        /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}(-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}){2}$/,
      );

    const rows = await listInvites();
    const mine = rows.filter((x) => x.batch === "it-批次");
    expect(mine).toHaveLength(3);
    expect(mine.every((x) => x.status === "available")).toBe(true);
    expect(mine.every((x) => x.expiresAt !== null)).toBe(true);
    expect(mine[0]?.createdByName).not.toBeNull();

    const audits = await getWebDb()
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.action, "invite.generate"));
    expect(audits).toHaveLength(1);
  });

  it("撤销：未用可撤；已用拒绝；不存在报 not_found", async () => {
    const gen = await generateInvites(ACTOR, { count: 2, days: 0, batch: "it-撤销" });
    if (!gen.ok) throw new Error("setup");
    const [a, b] = gen.codes;

    expect(await revokeInvite(ACTOR, a)).toEqual({ ok: true });
    const left = (await listInvites()).filter((x) => x.batch === "it-撤销");
    expect(left).toHaveLength(1);
    expect(left[0]?.code).toBe(b);

    // 模拟 b 被使用
    const db = getWebDb();
    await db
      .update(inviteCodes)
      .set({ usedBy: 90001, usedAt: new Date().toISOString().slice(0, 19).replace("T", " ") })
      .where(eq(inviteCodes.code, b));
    expect(await revokeInvite(ACTOR, b)).toEqual({ ok: false, code: "already_used" });
    expect((await listInvites()).find((x) => x.code === b)?.status).toBe("used");

    expect(await revokeInvite(ACTOR, "ZZZZ-ZZZZ-ZZZZ")).toEqual({ ok: false, code: "not_found" });
  });
});
