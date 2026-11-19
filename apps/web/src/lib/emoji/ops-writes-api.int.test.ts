// @vitest-environment node
/**
 * 表情管理 REST 服务层集成测试（M20.3 Step 4）：
 * prepareApiEmojiGroupCreate/Rename/Enabled/Delete/Reorder、prepareApiEmojiUpdate/Enabled
 * 的 prepare/lock/execute 三段、条件审计（同值不写）、name_exists/not_empty 裁决、
 * 管理读（含停用全量）；后台入口 createEmojiGroup 系列零回归。
 * emoji_groups.name 唯一键：重名冲突在 execute 兜底捕获为 name_exists。
 */
import "@/modules";
import { and, eq } from "drizzle-orm";
import { auditLog, DEMO, emojiGroups, emojis, getWebDb, insertIdOf } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import type { ConfigActor } from "@/lib/audit";
import { nowBeijingWallTime } from "@/lib/datetime";
import {
  createEmojiGroup,
  EMOJIS_DENIAL_HTTP,
  listEmojiGroupsAdmin,
  listEmojisAdminPage,
  prepareApiEmojiEnabled,
  prepareApiEmojiGroupCreate,
  prepareApiEmojiGroupDelete,
  prepareApiEmojiGroupEnabled,
  prepareApiEmojiGroupRename,
  prepareApiEmojiGroupReorder,
  prepareApiEmojiUpdate,
  toggleEmojiEnabled,
  updateEmoji,
} from "./service";

let tdb: TempDb;
const db = () => getWebDb();
const ADMIN: ConfigActor = { userId: DEMO.admin, via: "admin", ip: null };
const API_ACTOR: ConfigActor = { userId: DEMO.admin, via: "api", ip: "203.0.113.10" };
const TRACE = { requestId: "req-emoji-1", tokenSuffix: "aa77" };

/** 按 REST 幂等管线形态跑 prepare → 事务(lock → execute) → 提交后 afterCommit */
async function runPrepared(
  prepared: Awaited<ReturnType<typeof prepareApiEmojiGroupCreate>>,
): Promise<{ ok: true; data: unknown } | { ok: false; code: string }> {
  if (!prepared.ok) return prepared;
  const outcome = await db().transaction(async (tx) => {
    const locked = await prepared.lock(tx);
    if (!locked.ok) return locked;
    return locked.execute();
  });
  if (outcome.ok) await outcome.afterCommit?.();
  return outcome;
}

/** 直接落行造一组一表情（供更新/启停/非空删除用例） */
async function seedGroup(name: string): Promise<{ groupId: number; emojiId: number }> {
  const groupId = insertIdOf(
    await db().insert(emojiGroups).values({
      name,
      sort: 0,
      createdAt: nowBeijingWallTime(),
      updatedAt: nowBeijingWallTime(),
    }),
  );
  const emojiId = insertIdOf(
    await db()
      .insert(emojis)
      .values({
        groupId,
        name: `${name}-表情`,
        keywords: "seed",
        ext: "png",
        storageKey: null,
        sort: 1,
        enabled: true,
        createdAt: nowBeijingWallTime(),
        updatedAt: nowBeijingWallTime(),
      }),
  );
  return { groupId: Number(groupId), emojiId: Number(emojiId) };
}

const editAuditsOf = (id: number) =>
  db()
    .select({ after: auditLog.afterJson })
    .from(auditLog)
    .where(and(eq(auditLog.action, "admin.emoji.update"), eq(auditLog.targetId, String(id))));

beforeAll(async () => {
  tdb = await setupTempDb({ demo: true });
});

afterAll(() => {
  tdb?.teardown();
});

describe.skipIf(skipDb)("表情管理 REST 服务层（M20.3 Step 4）", () => {
  it("域码表与拒绝码全集对齐", () => {
    expect(EMOJIS_DENIAL_HTTP).toEqual({
      not_found: "not_found",
      name_exists: "state_conflict",
      not_empty: "state_conflict",
      bad_name: "bad_request",
    });
  });

  it("组建：bad_name 在 prepare；重名在 execute 兜底 name_exists；成功审计含 trace", async () => {
    expect(await prepareApiEmojiGroupCreate(API_ACTOR, "   ", TRACE)).toEqual({
      ok: false,
      code: "bad_name",
    });

    const created = await prepareApiEmojiGroupCreate(API_ACTOR, "REST 组", TRACE);
    expect(created.ok).toBe(true);
    const executed = await runPrepared(created);
    expect(executed).toMatchObject({ ok: true, data: { groupId: expect.any(Number) } });

    // 重名（prepare/lock 放行，execute 由唯一键兜底拒绝）
    const dup = await prepareApiEmojiGroupCreate(API_ACTOR, "REST 组", TRACE);
    expect(dup.ok).toBe(true);
    expect(await runPrepared(dup)).toEqual({ ok: false, code: "name_exists" });

    const audits = await db()
      .select({ after: auditLog.afterJson })
      .from(auditLog)
      .where(eq(auditLog.action, "admin.emoji.group.create"));
    const mine = audits.find((r) => (r.after as { name?: string }).name === "REST 组");
    expect(mine?.after).toMatchObject({
      name: "REST 组",
      via: "api",
      requestId: TRACE.requestId,
      tokenSuffix: TRACE.tokenSuffix,
    });

    // 后台入口零回归：同码拒绝 + 成功创建
    expect(await createEmojiGroup(ADMIN, "REST 组")).toEqual({ ok: false, code: "name_exists" });
    const bg = await createEmojiGroup(ADMIN, "后台组");
    expect(bg.ok).toBe(true);
  });

  it("组改名：同值不写审计；重名 execute 拒绝；不存在在锁段 not_found", async () => {
    const { groupId } = await seedGroup("改名组");

    // 同值改名：changed:false 且不写审计
    const beforeCount = (
      await db()
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(eq(auditLog.action, "admin.emoji.group.rename"))
    ).length;
    const same = await prepareApiEmojiGroupRename(API_ACTOR, groupId, "改名组", TRACE);
    expect(same.ok).toBe(true);
    const sameResult = await runPrepared(same);
    expect(sameResult).toMatchObject({ ok: true, data: { groupId, changed: false } });
    const afterSame = (
      await db()
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(eq(auditLog.action, "admin.emoji.group.rename"))
    ).length;
    expect(afterSame).toBe(beforeCount);

    // 改名到已存在的组名 → name_exists
    const dup = await prepareApiEmojiGroupRename(API_ACTOR, groupId, "REST 组", TRACE);
    expect(dup.ok).toBe(true);
    expect(await runPrepared(dup)).toEqual({ ok: false, code: "name_exists" });

    // 不存在 → 锁段 not_found
    const missing = await prepareApiEmojiGroupRename(API_ACTOR, 99999999, "任意", TRACE);
    expect(missing.ok).toBe(true);
    expect(await runPrepared(missing)).toEqual({ ok: false, code: "not_found" });
  });

  it("组启停/组排序：同值零变更；组删非空 not_empty；管理读含停用全量", async () => {
    const { groupId, emojiId } = await seedGroup("启停组");

    const toggle = await prepareApiEmojiGroupEnabled(API_ACTOR, groupId, false, TRACE);
    expect(toggle.ok).toBe(true);
    expect(await runPrepared(toggle)).toMatchObject({
      ok: true,
      data: { groupId, enabled: false, changed: true },
    });
    // 同值再停：changed:false
    const same = await prepareApiEmojiGroupEnabled(API_ACTOR, groupId, false, TRACE);
    expect(await runPrepared(same)).toMatchObject({
      ok: true,
      data: { groupId, enabled: false, changed: false },
    });

    const reorder = await prepareApiEmojiGroupReorder(API_ACTOR, groupId, 7, TRACE);
    expect(await runPrepared(reorder)).toMatchObject({
      ok: true,
      data: { groupId, sort: 7, changed: true },
    });

    // 组内仍有表情 → not_empty；后台入口同码（零回归）
    const del = await prepareApiEmojiGroupDelete(API_ACTOR, groupId, TRACE);
    expect(del.ok).toBe(true);
    expect(await runPrepared(del)).toEqual({ ok: false, code: "not_empty" });
    void emojiId;

    // 管理读：含停用组全量 + 表情计数
    const groups = await listEmojiGroupsAdmin();
    const mine = groups.find((g) => g.name === "启停组");
    expect(mine).toMatchObject({ enabled: false, sort: 7, emojiCount: 1 });
    const page = await listEmojisAdminPage({ groupId, page: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.groupName).toBe("启停组");
  });

  it("表情更新：值未变不写审计；值变化 changed:true 审计含 trace；表情启停同值零审计；后台入口零回归", async () => {
    const { emojiId } = await seedGroup("表情更新组");

    // REST 更新（值变化）
    const upd = await prepareApiEmojiUpdate(
      API_ACTOR,
      emojiId,
      { name: "新名", keywords: "新关键词", sort: 5 },
      TRACE,
    );
    expect(upd.ok).toBe(true);
    expect(await runPrepared(upd)).toMatchObject({
      ok: true,
      data: { emojiId, changed: true },
    });
    const [audit] = (await editAuditsOf(emojiId)).slice(-1);
    expect(audit.after).toMatchObject({
      name: "新名",
      via: "api",
      requestId: TRACE.requestId,
      tokenSuffix: TRACE.tokenSuffix,
    });

    // 同值更新：changed:false 不加审计
    const countBefore = (await editAuditsOf(emojiId)).length;
    const same = await prepareApiEmojiUpdate(
      API_ACTOR,
      emojiId,
      { name: "新名", keywords: "新关键词", sort: 5 },
      TRACE,
    );
    expect(await runPrepared(same)).toMatchObject({ ok: true, data: { changed: false } });
    expect((await editAuditsOf(emojiId)).length).toBe(countBefore);

    // REST 启停：同值零审计
    const toggleSame = await prepareApiEmojiEnabled(API_ACTOR, emojiId, true, TRACE);
    expect(await runPrepared(toggleSame)).toMatchObject({
      ok: true,
      data: { emojiId, enabled: true, changed: false },
    });

    // 后台入口零回归：停用 + 改名（结果码形态）
    expect(await toggleEmojiEnabled(ADMIN, emojiId, false)).toEqual({
      ok: true,
      groupId: expect.any(Number),
      changed: true,
    });
    // M20.3 Step 4：后台入口多返回 groupId（Action 回跳带 group 过滤防 Router Cache 旧列表）
    expect(await updateEmoji(ADMIN, emojiId, { name: "后台名", keywords: "", sort: 5 })).toEqual({
      ok: true,
      groupId: expect.any(Number),
      changed: true,
    });
    expect(await updateEmoji(ADMIN, 99999999, { name: "x", keywords: "", sort: 0 })).toEqual({
      ok: false,
      code: "not_found",
    });
  });
});
