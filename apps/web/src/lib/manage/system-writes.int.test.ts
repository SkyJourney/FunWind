// @vitest-environment node
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { auditLog, getWebDb, opsTasks, siteSettings, themePackages } from "@funwind/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GET as getAnnouncement,
  PATCH as editAnnouncement,
} from "@/app/api/manage/announcements/[announcementId]/route";
import {
  GET as listAnnouncements,
  POST as createAnnouncement,
} from "@/app/api/manage/announcements/route";
import { PATCH as setOpsParams } from "@/app/api/manage/ops/tasks/[taskKey]/params/route";
import { GET as getPointsLedger } from "@/app/api/manage/points/ledger/route";
import { POST as triggerOps } from "@/app/api/manage/ops/tasks/[taskKey]/trigger/route";
import { PATCH as setSettings } from "@/app/api/manage/settings/[group]/route";
import { GET as getSettings } from "@/app/api/manage/settings/route";
import { POST as setThemeEnabled } from "@/app/api/manage/themes/[packId]/enabled/route";
import { PATCH as editTheme } from "@/app/api/manage/themes/[packId]/route";
import { resetRateLimiter } from "@/lib/auth/ratelimit";
import { setSetting } from "@/lib/auth/settings";
import { getSiteChrome, invalidateSiteChrome } from "@/lib/chrome/site-chrome";
import { nowBeijingWallTime } from "@/lib/datetime";
import { applyPoints } from "@/lib/points/apply";
import { getLedgerPage } from "@/lib/points/ledger";
import { invalidateThemeCatalog } from "@/lib/theme/catalog";
import { DEFAULT_LIMITS_CONFIG } from "@/lib/limits/config";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { makeSiteAdmin } from "./int-fixtures";
import { createScopedAdminApiToken } from "./tokens";

let testDb: TempDb;
let uid: number;
let plain: string;
let suffix: string;

/** 通过真实路由入口验证权限门禁、请求解析与响应信封。 */
function request(path: string, method: string, data?: unknown, key?: string) {
  return new NextRequest(`http://localhost/api/manage/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${plain}`,
      "content-type": "application/json",
      ...(key ? { "idempotency-key": key } : {}),
    },
    body: JSON.stringify(data),
  });
}

function routeParams(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

function patchSetting(group: string, value: unknown, key = randomUUID()) {
  return setSettings(request(`settings/${group}`, "PATCH", value, key), routeParams({ group }));
}

/** 建一个与内置包、预置主题和其它用例隔离的自定义主题。 */
async function insertTheme(packId: string) {
  await getWebDb()
    .insert(themePackages)
    .values({
      id: packId,
      name: packId,
      description: " 原描述 ",
      definition: { surfaces: {} },
      assets: [],
      enabled: true,
      createdAt: "2026-11-20 12:00:00",
      updatedAt: "2026-11-20 12:00:00",
    });
}

function settingAudits(key: string) {
  return getWebDb()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, "setting.update"), eq(auditLog.targetId, key)))
    .orderBy(auditLog.id);
}

/** 读取完整落库行，不经过 REST 字段投影。 */
async function storedSetting(key: string) {
  const [row] = await getWebDb().select().from(siteSettings).where(eq(siteSettings.key, key));
  return row;
}

/** 直接写入夹具，避免通过 REST 校验提前滤掉用于测试审计投影的字段。 */
async function putSetting(key: string, value: object) {
  await getWebDb()
    .insert(siteSettings)
    .values({ key, value, updatedAt: "2026-11-20 12:00:00" })
    .onDuplicateKeyUpdate({ set: { value } });
}

describe.skipIf(skipDb)("管理 REST 系统写入（真实 MySQL）", () => {
  beforeAll(async () => {
    testDb = await setupTempDb();
    uid = await makeSiteAdmin("manage_system_test");
    ({ plain, suffix } = await createScopedAdminApiToken({
      userId: uid,
      name: "系统写入测试",
      days: 30,
      actor: { userId: uid, via: "admin" },
      permissions: {
        announcements: "write",
        ops: "write",
        points: "read",
        settings: "write",
        themes: "write",
      },
    }));
  });
  afterAll(async () => {
    await testDb?.teardown();
  });
  beforeEach(() => {
    resetRateLimiter();
    vi.stubEnv("MANAGE_API_WRITES", "on");
    vi.stubEnv("OPS_SERVICE_URL", "");
    vi.stubEnv("OPS_API_TOKEN", "");
    vi.stubEnv("BACKUP_SERVICE_URL", "");
    vi.stubEnv("BACKUP_OPS_TOKEN", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("未配置或断连返回 503；模拟管线受理返回 202 并写入带运行编号的审计", async () => {
    const path = "ops/tasks/backup.db/trigger";
    const params = routeParams({ taskKey: "backup.db" });
    const trigger = () => triggerOps(request(path, "POST", {}), params);
    const mock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(Response.json({ run_id: 7301 }, { status: 202 }));
    vi.stubGlobal("fetch", mock);

    const unconfigured = await trigger();
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toMatchObject({ error: { code: "ops_unavailable" } });
    expect(mock).not.toHaveBeenCalled();

    const baseUrl = "https://ops-trigger.invalid";
    const token = "synthetic-ops-trigger-token";
    vi.stubEnv("OPS_SERVICE_URL", baseUrl);
    vi.stubEnv("OPS_API_TOKEN", token);
    const disconnected = await trigger();
    expect(disconnected.status).toBe(503);
    expect(await disconnected.json()).toMatchObject({ error: { code: "ops_unavailable" } });

    const accepted = await trigger();
    expect(accepted.status).toBe(202);
    expect(accepted.headers.get("cache-control")).toBe("private, no-store");
    expect(await accepted.json()).toEqual({
      ok: true,
      data: { taskKey: "backup.db", runId: 7301, accepted: true },
    });
    expect(mock).toHaveBeenCalledTimes(2);
    for (const [url, init] of mock.mock.calls) {
      expect(url).toBe(`${baseUrl}/tasks/backup.db/runs`);
      expect(init).toMatchObject({ method: "POST", headers: { "x-ops-token": token } });
    }
    const rows = await getWebDb()
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "ops.task.run"));
    expect(rows).toHaveLength(1);
    expect(rows[0].afterJson).toMatchObject({
      runId: 7301,
      via: "api",
      requestId: expect.any(String),
      tokenSuffix: suffix,
    });
  });

  it("积分 REST 档位决定 SQL 条数与偏移，省略时与后台使用同一个 20 条默认值", async () => {
    for (let delta = 1; delta <= 23; delta++) {
      await applyPoints(
        { userId: uid, channel: "earn.gate_sale", delta, idempotencyKey: randomUUID() },
        { emitter: async () => {} },
      );
    }
    const read = (query: string) => getPointsLedger(request(`points/ledger?${query}`, "GET"));
    const readData = async (query: string) => {
      const response = await read(query);
      expect(response.status).toBe(200);
      return (await response.json()).data as Awaited<ReturnType<typeof getLedgerPage>>;
    };
    const first = await readData(`userId=${uid}`);
    expect(first.items).toHaveLength(20);
    expect(first).toEqual(await getLedgerPage(uid, 1));
    expect(first).toMatchObject({ page: 1, total: 23, totalPages: 2, balance: 276 });
    const second = await readData(`userId=${uid}&page=2&size=10`);
    expect(second).toMatchObject({ page: 2, total: 23, totalPages: 3, balance: 276 });
    expect(second.items).toEqual(first.items.slice(10));
    const last = await readData(`userId=${uid}&page=999&size=10`);
    expect(last.page).toBe(3);
    expect(last.items.map(({ delta }) => delta)).toEqual([3, 2, 1]);
    expect(await readData("userId=98765432")).toEqual({
      items: [],
      total: 0,
      page: 1,
      totalPages: 1,
      balance: 0,
      lifetimeEarned: 0,
      lifetimeSpent: 0,
    });
    for (const query of ["", "userId=0", `userId=${uid}&size=11`, `userId=${uid}&page=0`]) {
      const response = await read(query);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "bad_request" } });
    }
  });

  it("公告日期必传，显式 null 保留各自时间语义；管理列表按实际时间筛选", async () => {
    const post = (body: unknown, key = randomUUID()) =>
      createAnnouncement(request("announcements", "POST", body, key));
    const key = randomUUID();
    const before = nowBeijingWallTime();
    const body = { title: "日期回归-立即", bodyMd: "正文", startsAt: null, endsAt: null };
    const omitted = await post({ title: body.title, startsAt: null }, key);
    expect(omitted.status).toBe(400);
    expect(await omitted.json()).toMatchObject({ error: { code: "bad_request" } });
    const immediate = await post(body, key);
    expect(immediate.status).toBe(200);
    const receipt = await immediate.json();
    const replay = await post(body, key);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(receipt);

    const detail = async (id: number) => {
      const path = `announcements/${id}`;
      const response = await getAnnouncement(
        request(path, "GET"),
        routeParams({ announcementId: String(id) }),
      );
      expect(response.status).toBe(200);
      return (await response.json()).data;
    };
    const current = await detail(receipt.data.announcementId);
    expect(current.startsAt >= before && current.startsAt <= nowBeijingWallTime()).toBe(true);
    expect(current).toMatchObject({ endsAt: null, status: "active", bodyMd: "正文" });
    const startsAt = "2099-01-01 00:00:00";
    const future = await post({ title: "日期回归-定时", startsAt, endsAt: "2000-01-01 00:00:00" });
    expect(future.status).toBe(200);
    const {
      data: { announcementId },
    } = await future.json();

    const list = async (status: string) => {
      const query = new URLSearchParams({ q: "日期回归-", status, size: "10" });
      const response = await listAnnouncements(request(`announcements?${query}`, "GET"));
      expect(response.status).toBe(200);
      return (await response.json()).data.items;
    };
    expect(await list("ended")).toEqual([
      expect.objectContaining({ id: announcementId, status: "scheduled" }),
    ]);
    expect(await list("scheduled")).toEqual([
      expect.objectContaining({ id: announcementId, status: "scheduled" }),
    ]);
    const [active] = await list("active");
    expect(active).toMatchObject({ id: current.id, status: "active" });
    expect(active).not.toHaveProperty("bodyMd");

    const path = `announcements/${announcementId}`;
    const patch = (body: unknown, idempotencyKey = randomUUID()) =>
      editAnnouncement(
        request(path, "PATCH", body, idempotencyKey),
        routeParams({ announcementId: String(announcementId) }),
      );
    const editBody = { title: "日期回归-定时", startsAt: null, endsAt: null };
    for (const input of [
      { title: editBody.title, endsAt: null },
      { ...editBody, startsAt: "2099-02-29 00:00:00" },
    ]) {
      const invalid = await patch(input);
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ error: { code: "bad_request" } });
    }
    expect(await detail(announcementId)).toMatchObject({ startsAt, endsAt: "2000-01-01 00:00:00" });
    const editKey = randomUUID();
    const edited = await patch(editBody, editKey);
    expect(edited.status).toBe(200);
    const editReceipt = await edited.json();
    expect(editReceipt).toMatchObject({ data: { changed: true } });
    expect(
      await (await patch({ title: "日期回归-定时", startsAt: null, endsAt: null }, editKey)).json(),
    ).toEqual(editReceipt);
    expect(await detail(announcementId)).toMatchObject({ startsAt, endsAt: null });
    expect(await list("ended")).toEqual([]);
  });

  it("任务键与版本参与配置指纹，同键改目标或版本均拒绝", async () => {
    const taskKey = "backup.db";
    const [task] = await getWebDb().select().from(opsTasks).where(eq(opsTasks.taskKey, taskKey));
    const key = randomUUID();
    const payload = { expectedRevision: task.revision, params: { keep: 19 } };
    const write = (target: string, body: typeof payload, idempotencyKey = key) =>
      setOpsParams(
        request(`ops/tasks/${target}/params`, "PATCH", body, idempotencyKey),
        routeParams({ taskKey: target }),
      );
    const first = await write(taskKey, payload);
    expect(first.status).toBe(200);
    const expected = { ok: true, data: { id: task.id, revision: task.revision + 1 } };
    expect(await first.json()).toEqual(expected);
    expect(await (await write(taskKey, payload)).json()).toEqual(expected);
    for (const response of [
      await write("backup.storage", payload),
      await write(taskKey, { ...payload, expectedRevision: task.revision + 1 }),
    ]) {
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "idempotency_conflict" } });
    }
    const stale = await write(taskKey, payload, randomUUID());
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "state_conflict" } });
    const rows = await getWebDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "ops.task.update"), eq(auditLog.targetId, taskKey)));
    expect(rows).toHaveLength(1);
  });

  it("设置 GET 与 REST 审计共用投影；后台历史审计和真实值变化保持原样", async () => {
    const group = "email.security";
    const publicValue = { enabled: true };
    const olderValue = { ...publicValue, internal: "合成旧值" };
    const storedValue = { ...publicValue, internal: "合成现值" };
    await putSetting(group, olderValue);
    await setSetting(group, storedValue, { userId: uid, via: "admin" });
    const [history] = await settingAudits(group);
    expect(history.beforeJson).toEqual({ value: olderValue });
    expect(history.afterJson).toEqual({ value: storedValue, via: "admin" });

    const get = (name: string) => getSettings(request(`settings?group=${name}`, "GET"));
    const unknown = await get("constructor");
    expect(unknown.status).toBe(404);
    const snapshot = await get(group);
    expect(snapshot.status).toBe(200);
    expect(await snapshot.json()).toEqual({
      ok: true,
      data: { group, key: group, value: publicValue, updatedAt: expect.any(String) },
    });

    // 公开值相同，但替换实际移除了额外字段，仍须写入并审计。
    expect((await patchSetting(group, publicValue)).status).toBe(200);
    expect((await storedSetting(group)).value).toEqual(publicValue);
    // 默认生成新幂等键，验证同值写入而非回放。
    expect((await patchSetting(group, publicValue)).status).toBe(200);
    const rows = await settingAudits(group);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(history);
    expect(rows[1].beforeJson).toEqual({ value: publicValue });
    expect(rows[1].afterJson).toEqual({
      value: publicValue,
      via: "api",
      requestId: expect.any(String),
      tokenSuffix: suffix,
    });
  });

  const validLimits = {
    titleMax: 144,
    bodyMax: 12000,
    memberPostIntervalSec: 0,
    memberThreadsPerDay: 9,
    memberUploadsPerDay: 8,
    memberPmPerDay: 7,
    memberEditWindowSec: 7200,
    adminPostIntervalSec: 0,
    adminThreadsPerDay: 0,
    adminUploadsPerDay: 0,
    adminPmPerDay: 0,
    adminEditWindowSec: 0,
  };

  it.each(["9", "", " ", true, null, [], [9], -1, 1.5, 1000001].map((value) => ({ value })))(
    "频控和每日汇总拒绝非法数字输入 $value",
    async ({ value }) => {
      for (const response of [
        await patchSetting("limits", { ...validLimits, titleMax: value }),
        await patchSetting("limits", { ...validLimits, bodyMax: value }),
        await patchSetting("limits", { ...validLimits, memberPostIntervalSec: value }),
        await patchSetting("email.digest", { hour: value }),
      ]) {
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: "bad_request" } });
      }
    },
  );

  it("频控与每日汇总接受合法整数（含零），频控保留其他角色配置", async () => {
    const custom = { ...DEFAULT_LIMITS_CONFIG.roles.member, threadsPerDay: 13 };
    await putSetting("limits", {
      ...DEFAULT_LIMITS_CONFIG,
      roles: { ...DEFAULT_LIMITS_CONFIG.roles, "custom-probe": custom },
    });
    expect((await patchSetting("limits", validLimits)).status).toBe(200);
    expect((await patchSetting("email.digest", { hour: 0 })).status).toBe(200);
    const limits = await getSettings(request("settings?group=limits", "GET"));
    expect(limits.status).toBe(200);
    expect(await limits.json()).toMatchObject({
      data: {
        value: { titleMax: 144, roles: { "custom-probe": custom, member: { postIntervalSec: 0 } } },
      },
    });
    const digest = await getSettings(request("settings?group=email.digest", "GET"));
    expect(digest.status).toBe(200);
    expect(await digest.json()).toMatchObject({ data: { value: { hour: 0 } } });
  });

  it("导航拒绝控制字符与非站内地址，原值、更新时间、审计和缓存均不变", async () => {
    await putSetting("site.nav", [{ label: "已有导航", href: "/help?q=1#top" }]);
    invalidateSiteChrome();
    const cached = await getSiteChrome();
    const stored = await storedSetting("site.nav");
    const audits = await settingAudits("site.nav");
    const rejectedHrefs = [
      "//invalid.example.com",
      "https://example.invalid/a",
      ...[0, 9, 10, 13, 31, 127].map((code) => `/page-0#top${String.fromCharCode(code)}`),
    ];
    for (const href of rejectedHrefs) {
      const rejected = await patchSetting("nav", [{ label: "导航", href }]);
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({ error: { code: "bad_request" } });
    }
    expect(await storedSetting("site.nav")).toEqual(stored);
    expect(await settingAudits("site.nav")).toEqual(audits);
    expect(await getSiteChrome()).toBe(cached);
  });

  it("导航保留站内查询和锚点、友链仍接受外链，区分同值、数组重排和回放", async () => {
    invalidateSiteChrome();
    const before = await getSiteChrome();
    const items = Array.from({ length: 12 }, (_, i) => ({
      label: `导航 ${i}`,
      href: `/page-${i}?sort=recent#top`,
    }));
    const input = items.map(({ label, href }) => ({ label, href: `  ${href}  ` }));
    const key = randomUUID();
    const changed = await patchSetting("nav", input, key);
    expect(changed.status).toBe(200);
    const receipt = await changed.json();
    const after = await getSiteChrome();
    expect(after).not.toBe(before);
    expect(after.nav).toEqual(items.slice(0, 10));
    const read = await getSettings(request("settings?group=nav", "GET"));
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ data: { value: items } });
    const stored = await storedSetting("site.nav");
    const baselineAudits = await settingAudits("site.nav");
    expect(stored.value).toEqual(items);
    expect(baselineAudits).toHaveLength(1);

    const replay = await patchSetting("nav", input, key);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(receipt);
    expect((await patchSetting("nav", [], key)).status).toBe(409);
    expect(await getSiteChrome()).toBe(after);
    expect(await storedSetting("site.nav")).toEqual(stored);
    expect(await settingAudits("site.nav")).toEqual(baselineAudits);

    // 新键重新执行：对象键重排不审计，导航数组重排仍是一次真实变更。
    const reorderedKeys = items.map(({ label, href }) => ({ href, label }));
    expect((await patchSetting("nav", reorderedKeys)).status).toBe(200);
    expect(await settingAudits("site.nav")).toEqual(baselineAudits);
    const reorderedItems = [...items].reverse();
    expect((await patchSetting("nav", reorderedItems)).status).toBe(200);
    expect((await storedSetting("site.nav")).value).toEqual(reorderedItems);
    expect((await getSiteChrome()).nav).toEqual(reorderedItems.slice(0, 10));
    const audits = await settingAudits("site.nav");
    expect(audits).toHaveLength(2);
    expect(audits[1].beforeJson).toEqual({ value: items });
    expect(audits[1].afterJson).toMatchObject({ value: reorderedItems, via: "api" });

    const links = [
      { label: "站内", href: "/a?page=2#top" },
      { label: "外链", href: "https://example.invalid/a?q=1#top" },
    ];
    expect((await patchSetting("links", links)).status).toBe(200);
    expect((await getSiteChrome()).links).toEqual(links.slice(1));
    const storedLinks = await getSettings(request("settings?group=links", "GET"));
    expect(await storedLinks.json()).toMatchObject({ data: { value: links } });
  });

  it("主题元数据名称与描述超过数据库列上限时返回 400，不截断、不改版本", async () => {
    const packId = "rest-metadata";
    await insertTheme(packId);
    const patch = (body: unknown) =>
      editTheme(
        request(
          `themes/${packId}`,
          "PATCH",
          { expectedRevision: 1, ...(body as object) },
          randomUUID(),
        ),
        routeParams({ packId }),
      );
    const name = "名".repeat(60);
    const description = "描".repeat(200);
    for (const response of [
      await patch({ name: `${name}超` }),
      await patch({ description: `${description}超` }),
    ]) {
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "bad_request" } });
    }
    const getPack = async () =>
      (await getWebDb().select().from(themePackages).where(eq(themePackages.id, packId)))[0];
    expect(await getPack()).toMatchObject({ revision: 1, name: packId, description: " 原描述 " });
    expect((await patch({ name: `  ${name}  `, description: `  ${description}  ` })).status).toBe(
      200,
    );
    expect(await getPack()).toMatchObject({ revision: 2, name, description });
  });

  it("主题实际启停提交后重算站点默认主题，保护拒绝、同值和幂等回放不刷新", async () => {
    const packId = "rest-chrome";
    await insertTheme(packId);
    await putSetting("site.theme", { pack: packId });
    invalidateThemeCatalog();
    invalidateSiteChrome();
    const before = await getSiteChrome();
    expect(before.themePack).toBe(packId);
    const toggle = (target: string, enabled: boolean, key = randomUUID()) =>
      setThemeEnabled(
        request(`themes/${target}/enabled`, "POST", { enabled }, key),
        routeParams({ packId: target }),
      );
    expect((await toggle("default", false)).status).toBe(409);
    expect(await getSiteChrome()).toBe(before);

    const key = randomUUID();
    const disabled = await toggle(packId, false, key);
    expect(disabled.status).toBe(200);
    const receipt = await disabled.json();
    expect(receipt).toMatchObject({ data: { enabled: false, changed: true, revision: 2 } });
    const after = await getSiteChrome();
    expect(after.themePack).toBe("default");
    expect(after).not.toBe(before);
    expect(await (await toggle(packId, false, key)).json()).toEqual(receipt);
    expect(await (await toggle(packId, false)).json()).toMatchObject({
      data: { changed: false, revision: 2 },
    });
    expect(await getSiteChrome()).toBe(after);

    expect((await toggle(packId, true)).status).toBe(200);
    expect((await getSiteChrome()).themePack).toBe(packId);
  });
});
