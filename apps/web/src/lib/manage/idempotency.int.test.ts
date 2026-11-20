// @vitest-environment node
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { auditLog, campaigns, getWebDb, insertIdOf, manageApiIdempotency } from "@funwind/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PATCH as editCampaign } from "@/app/api/manage/campaigns/[campaignId]/route";
import { resetRateLimiter } from "@/lib/auth/ratelimit";
import { hashToken } from "@/lib/auth/token";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { runIdempotentManageWrite, type ManageWriteIdentity } from "./idempotency";
import { makeSiteAdmin } from "./int-fixtures";
import { createScopedAdminApiToken } from "./tokens";

const target = 100;
const original = {
  value: [
    { label: "首页", href: "/" },
    { label: "版块", href: "/forums" },
  ],
};
const reordered = {
  value: [
    { href: "/", label: "首页" },
    { href: "/forums", label: "版块" },
  ],
};
const db = () => getWebDb();

/** 固定旧指纹的历史格式，不调用当前实现制造回执。 */
async function putOldReceipt(
  identity: ManageWriteIdentity,
  targetId: number,
  input: Record<string, unknown>,
  response: object,
) {
  const requestHash = hashToken(
    JSON.stringify([
      targetId,
      Object.keys(input)
        .sort()
        .map((key) => [key, input[key]]),
    ]),
  );
  await db()
    .insert(manageApiIdempotency)
    .values({
      tokenId: identity.tokenId,
      endpoint: identity.endpoint,
      keyHash: hashToken(identity.idempotencyKey),
      requestHash,
      response,
      expiresAt: sql`NOW() + INTERVAL 6 HOUR`,
    });
}

function identityForTest(): ManageWriteIdentity {
  return {
    tokenId: hashToken(randomUUID()),
    endpoint: "settings.update",
    idempotencyKey: randomUUID(),
    requestId: randomUUID(),
  };
}

let tempDb: TempDb;

describe.skipIf(skipDb)("管理 REST 幂等指纹（真实 MySQL）", () => {
  beforeAll(async () => {
    tempDb = await setupTempDb();
  });
  afterAll(async () => {
    await tempDb?.teardown();
  });
  beforeEach(() => {
    vi.stubEnv("MANAGE_API_WRITES", "on");
    resetRateLimiter();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("嵌套对象键重排可以回放，数组重排属于新意图", async () => {
    const identity = identityForTest();
    const data = { written: true };
    const afterCommit = vi.fn(async () => {});
    const lock = vi.fn(async () => async () => ({ data, afterCommit }));
    await expect(runIdempotentManageWrite(identity, target, original, lock)).resolves.toEqual(data);
    await expect(runIdempotentManageWrite(identity, target, reordered, lock)).resolves.toEqual(
      data,
    );
    await expect(
      runIdempotentManageWrite(identity, target, { value: [...original.value].reverse() }, lock),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(lock).toHaveBeenCalledTimes(1);
    expect(afterCommit).toHaveBeenCalledTimes(1);
  });

  it("旧嵌套回执仅精确匹配旧摘要，不重新执行或刷新回执", async () => {
    const identity = identityForTest();
    const data = { from: "历史回执" };
    const lock = vi.fn(async () => async () => ({ data: { from: "重新执行" } }));
    await putOldReceipt(identity, target, original, data);
    const read = () =>
      db()
        .select()
        .from(manageApiIdempotency)
        .where(eq(manageApiIdempotency.tokenId, identity.tokenId));
    const before = await read();
    await expect(runIdempotentManageWrite(identity, target, original, lock)).resolves.toEqual(data);
    await expect(runIdempotentManageWrite(identity, target, reordered, lock)).rejects.toMatchObject(
      {
        code: "idempotency_conflict",
      },
    );
    expect(lock).not.toHaveBeenCalled();
    expect(await read()).toEqual(before);
  });

  it("活动旧回执必须证明原请求版本，不能按活动当前版本回放", async () => {
    const uid = await makeSiteAdmin("manage_campaign_replay");
    const token = await createScopedAdminApiToken({
      userId: uid,
      name: "活动旧回执测试",
      days: 30,
      actor: { userId: uid, via: "admin" },
      permissions: { campaigns: "write" },
    });
    const input = {
      name: "活动旧回执夹具",
      effect: "theme.pack",
      target: "default",
      startsAt: "2099-01-01 00:00:00",
      endsAt: "2099-02-01 00:00:00",
      priority: 0,
    };
    const id = insertIdOf(
      await db()
        .insert(campaigns)
        .values({
          name: input.name,
          effect: input.effect,
          config: { pack: input.target },
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          revision: 7,
          createdAt: sql`NOW()`,
          updatedAt: sql`NOW()`,
        }),
    );
    const identity = {
      tokenId: token.id,
      endpoint: "campaigns.edit",
      idempotencyKey: randomUUID(),
      requestId: randomUUID(),
    } as const;
    const patch = (expectedRevision: number, key = identity.idempotencyKey) =>
      editCampaign(
        new NextRequest(`http://localhost/api/manage/campaigns/${id}`, {
          method: "PATCH",
          headers: {
            authorization: `Bearer ${token.plain}`,
            "content-type": "application/json",
            "idempotency-key": key,
          },
          body: JSON.stringify({ ...input, expectedRevision }),
        }),
        { params: Promise.resolve({ campaignId: String(id) }) },
      );
    await putOldReceipt(identity, id, input, { id, revision: 2 });
    const replay = await patch(1);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ok: true, data: { id, revision: 2 } });
    const wrongVersion = await patch(7);
    expect(wrongVersion.status).toBe(409);
    expect(await wrongVersion.json()).toMatchObject({ error: { code: "idempotency_conflict" } });

    const bad = { ...identity, idempotencyKey: randomUUID() };
    await putOldReceipt(bad, id, input, { id: id + 1, revision: 2 });
    const wrongTarget = await patch(1, bad.idempotencyKey);
    expect(wrongTarget.status).toBe(409);
    expect(await wrongTarget.json()).toMatchObject({ error: { code: "idempotency_conflict" } });
    expect(await db().select().from(campaigns).where(eq(campaigns.id, id))).toMatchObject([
      { id, revision: 7 },
    ]);
    const audit = () =>
      db()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, "campaign.update"), eq(auditLog.targetId, String(id))));
    expect(await audit()).toHaveLength(0);

    const stale = await patch(1, randomUUID());
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "state_conflict" } });

    const key = randomUUID();
    const expected = { ok: true, data: { id, revision: 8 } };
    for (const response of [await patch(7, key), await patch(7, key)]) {
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(expected);
    }
    const changedInput = await patch(8, key);
    expect(changedInput.status).toBe(409);
    expect(await changedInput.json()).toMatchObject({ error: { code: "idempotency_conflict" } });
    expect(await audit()).toHaveLength(1);
  });
});
