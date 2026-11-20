import { createHash, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { FIX as E2E_FIX } from "./support/fixtures";
import {
  MISSING_ID,
  READ_DOMAINS,
  READ_ENDPOINTS,
  REST_ENDPOINTS,
  WRITE_ENDPOINTS,
  bearer,
  cleanupManageArtifacts,
  createAdminUser,
  expectManageError,
  expectOpsPipelineDisconnected,
  fillEndpointPath,
  insertLegacyToken,
  issueManageToken,
  runTag,
  type ManageDomain,
  type ManageLevel,
} from "./support/manage-api";
import { USERS, loginAs } from "./support/session";

/** 按独立契约逐档核对全部端点。写档包含同域读权，历史档只保留明确列出的九个 GET。 */
const LEGACY_READ_PATHS = new Set<string>([
  "/api/manage/whoami",
  "/api/manage/contents",
  "/api/manage/contents/{id}",
  "/api/manage/users",
  "/api/manage/users/{uid}",
  "/api/manage/stats",
  "/api/manage/audit-logs",
  "/api/manage/emails",
  "/api/manage/push-logs",
]);

const TAG = runTag();
const MARKER = `matrix-${TAG}`;
const NAME_PREFIX = `E2E REST 矩阵 · ${TAG} · `;
const READ_FIXTURE_NAME = `${MARKER}-read`;
const ANNOUNCEMENT_BODY = "矩阵夹具公告正文";
const EMOJI_KEYWORD = `${MARKER}-keyword`;
const MAIL_RECIPIENT = `${MARKER}@example.invalid`;
const PUSH_ENDPOINT = `https://push.example.invalid/${MARKER}`;
const PUSH_ERROR = "矩阵夹具推送失败";
const namedRowIds = { emojiGroup: 0, emoji: 0, email: 0, push: 0 };

/** 夹具常量来自隔离库演示种子和 E2E 水区数据。 */
const FIX = {
  threadId: 951001,
  firstPostId: 9_000_000 + 951001,
  userId: USERS.alice,
  username: "demo_alice",
  minUsers: 8,
  minThreads: 70,
};

const detailTargets = {
  id: FIX.threadId,
  uid: FIX.userId,
  fid: E2E_FIX.water.id,
  roleKey: "admin",
  packId: E2E_FIX.customThemePack.id,
  reportId: 0,
  announcementId: 0,
  campaignId: 0,
};

const readQueries: Readonly<Record<string, string>> = {
  "/api/manage/contents/{id}": "?kind=thread",
  "/api/manage/points/ledger": `?userId=${FIX.userId}`,
};

/** 每档只授予表中写明的域。全域读仅覆盖有 GET 的域。 */
const PROFILE_LEVELS = {
  identity: { identity: "read" },
  "contents-read": { contents: "read" },
  "contents-write": { contents: "write" },
  users: { users: "read" },
  "users-write": { users: "write" },
  "reports-read": { reports: "read" },
  "reports-write": { reports: "write" },
  "announcements-write": { announcements: "write" },
  "campaigns-write": { campaigns: "write" },
  "invites-write": { invites: "write" },
  "forums-write": { forums: "write" },
  "polls-write": { polls: "write" },
  "pm-write": { pm: "write" },
  "badges-write": { badges: "write" },
  "points-write": { points: "write" },
  "emojis-write": { emojis: "write" },
  "roles-read": { roles: "read" },
  "roles-write": { roles: "write" },
  "settings-read": { settings: "read" },
  "settings-write": { settings: "write" },
  "ops-read": { ops: "read" },
  "ops-write": { ops: "write" },
  "themes-read": { themes: "read" },
  "themes-write": { themes: "write" },
  stats: { stats: "read" },
  "audit-logs": { "audit-logs": "read" },
  emails: { emails: "read" },
  "push-logs": { "push-logs": "read" },
  "all-read": Object.fromEntries(READ_DOMAINS.map((domain) => [domain, "read" as const])),
  legacy: {},
} satisfies Record<string, Partial<Record<ManageDomain, ManageLevel>>>;

type ProfileKey = keyof typeof PROFILE_LEVELS;
const profileKeys = Object.keys(PROFILE_LEVELS) as ProfileKey[];
const writeTargets = {
  sessionId: "0".repeat(64),
  code: `missing-${TAG}`,
  batch: `missing-${TAG}`,
  roleKey: `missing-${TAG}`,
  permission: "forum.moderate",
  group: "missing.group",
  taskKey: `missing-${TAG}`,
  packId: `missing-${TAG}`,
};

/** 每档的 30 次读和 52 次写分摊给同一持有人的两枚同授权令牌；附加读按域分摊。 */
const TOKENS_PER_PROFILE = 2;
const PROFILES_PER_ADMIN = Math.floor(5 / TOKENS_PER_PROFILE);
const tokens = new Map<ProfileKey, { read: string; write: string }>();
const tokenNames: string[] = [];
const adminUserIds: number[] = [];

const readToken = (key: ProfileKey) => tokens.get(key)!.read;
const tokenName = (key: ProfileKey, part: "read" | "write") => `${NAME_PREFIX}${key} · ${part}`;

/** 状态预期逐端点判断授权。历史档不从域推算，新增同域端点不会自动获得授权。 */
function grantsEndpoint(key: ProfileKey, endpoint: (typeof REST_ENDPOINTS)[number]): boolean {
  if (key === "legacy") {
    return endpoint.method === "GET" && LEGACY_READ_PATHS.has(endpoint.path);
  }
  const levels: Partial<Record<ManageDomain, ManageLevel>> = PROFILE_LEVELS[key];
  const level = levels[endpoint.domain];
  return level === "write" || (level === "read" && endpoint.method === "GET");
}

test.describe.configure({ mode: "serial" });

test.describe(`管理 REST 权限矩阵 · ${profileKeys.length} 档 × ${REST_ENDPOINTS.length} 端点`, () => {
  test.afterAll(async () => {
    try {
      await withE2eDb(async (q) => {
        if (detailTargets.reportId) {
          await q.exec("DELETE FROM reports WHERE id = ?", [detailTargets.reportId]);
        }
        await q.exec("DELETE FROM announcements WHERE title IN (?, ?)", [
          MARKER,
          READ_FIXTURE_NAME,
        ]);
        await q.exec("DELETE FROM campaigns WHERE name IN (?, ?)", [MARKER, READ_FIXTURE_NAME]);
        await q.exec("DELETE FROM invite_codes WHERE batch = ?", [MARKER]);
        await q.exec("DELETE FROM emojis WHERE id = ?", [namedRowIds.emoji]);
        await q.exec("DELETE FROM emoji_groups WHERE id = ? OR name = ?", [
          namedRowIds.emojiGroup,
          MARKER,
        ]);
        await q.exec("DELETE FROM email_log WHERE id = ?", [namedRowIds.email]);
        await q.exec("DELETE FROM push_log WHERE id = ?", [namedRowIds.push]);
        await q.exec("DELETE FROM roles WHERE `key` = ?", [MARKER]);
      });
    } finally {
      await cleanupManageArtifacts({
        tokenNames,
        adminUserIds: [],
        temporaryAdminUserIds: adminUserIds,
        authorUserIds: [],
        targets: [],
      });
    }
  });

  test("准备：签发同档令牌并建立详情夹具", async ({ page }) => {
    // 此用例需依次完成真实签发页面的提交，超时预算只用于准备夹具。
    test.setTimeout(240_000);
    expectOpsPipelineDisconnected(test.info().config);
    expect([READ_ENDPOINTS.length, WRITE_ENDPOINTS.length]).toEqual([30, 52]);
    expect(profileKeys).toHaveLength(30);
    await withE2eDb(async (q) => {
      detailTargets.reportId = (
        await q.exec(
          `INSERT INTO reports (post_id, reporter_id, reason, status, created_at)
           VALUES (?, ?, '矩阵夹具举报', 'pending', NOW())`,
          [FIX.firstPostId, FIX.userId],
        )
      ).insertId;
      detailTargets.announcementId = (
        await q.exec(
          `INSERT INTO announcements
             (title, body_md, level, audience, starts_at, ends_at, created_by, created_at, updated_at)
           VALUES (?, ?, 'important', 'members', '2000-01-01 00:00:00', '2000-01-02 00:00:00', ?, NOW(), NOW())`,
          [READ_FIXTURE_NAME, ANNOUNCEMENT_BODY, USERS.admin],
        )
      ).insertId;
      detailTargets.campaignId = (
        await q.exec(
          `INSERT INTO campaigns (name, effect, config, starts_at, enabled, created_at, updated_at)
           VALUES (?, 'theme.pack', JSON_OBJECT('pack', 'default'), NOW(), 0, NOW(), NOW())`,
          [READ_FIXTURE_NAME],
        )
      ).insertId;
      namedRowIds.emojiGroup = (
        await q.exec(
          `INSERT INTO emoji_groups (name, enabled, created_at, updated_at)
           VALUES (?, 0, NOW(), NOW())`,
          [READ_FIXTURE_NAME],
        )
      ).insertId;
      namedRowIds.emoji = (
        await q.exec(
          `INSERT INTO emojis (group_id, name, keywords, ext, enabled, created_at, updated_at)
           VALUES (?, ?, ?, 'gif', 0, NOW(), NOW())`,
          [namedRowIds.emojiGroup, READ_FIXTURE_NAME, EMOJI_KEYWORD],
        )
      ).insertId;
      // 仅写入可检索的日志行，不触发邮件或推送发送。
      namedRowIds.email = (
        await q.exec(
          `INSERT INTO email_log (kind, scene, to_email, user_id, subject, status, created_at)
           VALUES ('digest', 'digest', ?, ?, ?, 'sent', NOW())`,
          [MAIL_RECIPIENT, FIX.userId, READ_FIXTURE_NAME],
        )
      ).insertId;
      namedRowIds.push = (
        await q.exec(
          `INSERT INTO push_log (kind, scene, endpoint, user_id, title, status, error, created_at)
           VALUES ('notice', 'post-mentioned', ?, ?, ?, 'failed', ?, NOW())`,
          [PUSH_ENDPOINT, FIX.userId, READ_FIXTURE_NAME, PUSH_ERROR],
        )
      ).insertId;
    });

    for (const [index, key] of profileKeys.entries()) {
      if (index % PROFILES_PER_ADMIN === 0) {
        const adminId = await withE2eDb((q) => createAdminUser(q, `${TAG}-${index}`));
        adminUserIds.push(adminId);
        await loginAs(page.context(), adminId);
      }
      const holder = adminUserIds.at(-1)!;
      const issue = async (part: "read" | "write") => {
        const name = tokenName(key, part);
        tokenNames.push(name);
        return key === "legacy"
          ? withE2eDb((q) => insertLegacyToken(q, holder, name))
          : issueManageToken(page, name, PROFILE_LEVELS[key]);
      };
      tokens.set(key, { read: await issue("read"), write: await issue("write") });
    }
    expect(tokenNames).toHaveLength(profileKeys.length * TOKENS_PER_PROFILE);
  });

  for (const key of profileKeys) {
    test(`矩阵 · ${key} 档位下的全部端点`, async ({ request }) => {
      const { read, write } = tokens.get(key)!;
      for (const endpoint of READ_ENDPOINTS) {
        const path =
          fillEndpointPath(endpoint.path, detailTargets) + (readQueries[endpoint.path] ?? "");
        const response = await request.get(path, { headers: bearer(read) });
        if (grantsEndpoint(key, endpoint)) {
          expect(response.status(), `${key} → GET ${path}`).toBe(200);
          expect(await response.json()).toMatchObject({ ok: true });
        } else {
          await expectManageError(response, 403, "forbidden");
        }
      }

      for (const endpoint of WRITE_ENDPOINTS) {
        const path = fillEndpointPath(endpoint.path, writeTargets);
        const response = await request.fetch(path, {
          method: endpoint.method,
          headers: { ...bearer(write), "Idempotency-Key": randomUUID() },
          data:
            typeof endpoint.sampleBody === "function"
              ? endpoint.sampleBody(MARKER)
              : endpoint.sampleBody,
        });
        if (!grantsEndpoint(key, endpoint)) {
          await expectManageError(response, 403, "forbidden");
        } else if ("expectedStatus" in endpoint) {
          expect(response.status(), `${key} → ${endpoint.method} ${path}`).toBe(
            endpoint.expectedStatus,
          );
          expect(await response.json()).toMatchObject({ ok: true });
        } else {
          await expectManageError(response, 404, "not_found");
        }
      }
    });
  }

  test("查询语义 · whoami 报告持有人身份、权限与令牌精确授权", async ({ request }) => {
    const identity = readToken("identity");
    const basic = await request.get("/api/manage/whoami", { headers: bearer(identity) });
    expect(basic.status()).toBe(200);
    const body = (await basic.json()) as {
      data: { user: { id: number }; permissions: string[]; tokenPermissions?: unknown };
    };
    expect(body.data.user.id).toBe(adminUserIds[0]!);
    expect(body.data.permissions).toContain("site.admin");
    expect(body.data.tokenPermissions).toBeUndefined();

    // 身份域令牌的精确授权就是 whoami 本身；内容写域令牌不含身份域，
    // 调 whoami 属跨域拒绝（矩阵用例已覆盖 403），不在此重复。
    const detailed = await request.get("/api/manage/whoami?include=token_permissions", {
      headers: bearer(identity),
    });
    expect(detailed.status()).toBe(200);
    const detail = (await detailed.json()) as {
      data: { tokenPermissions: { granted: { id: string }[]; effective: { id: string }[] } };
    };
    expect(detail.data.tokenPermissions.granted.map((e) => e.id)).toEqual(["whoami"]);
    expect(detail.data.tokenPermissions.effective.map((e) => e.id)).toEqual(["whoami"]);

    // include 仅识别精确的诊断开关，其余值不展开权限，也不返回 400。
    const unknownInclude = await request.get("/api/manage/whoami?include=bogus", {
      headers: bearer(identity),
    });
    expect(unknownInclude.status()).toBe(200);
    expect((await unknownInclude.json()).data).toEqual(body.data);

    // 两枚历史令牌都须呈现同一冻结快照，写探针才确实来自历史档。
    for (const token of [tokens.get("legacy")!.read, tokens.get("legacy")!.write]) {
      const response = await request.get("/api/manage/whoami?include=token_permissions", {
        headers: bearer(token),
      });
      expect(response.status()).toBe(200);
      const { data } = (await response.json()) as {
        data: { tokenPermissions: { granted: { path: string; method: string }[] } };
      };
      expect(data.tokenPermissions.granted).toHaveLength(LEGACY_READ_PATHS.size);
      expect(new Set(data.tokenPermissions.granted.map((e) => e.path))).toEqual(LEGACY_READ_PATHS);
      expect(data.tokenPermissions.granted.every((e) => e.method === "GET")).toBe(true);
    }
  });

  test("查询语义 · 内容列表与详情断言夹具数据", async ({ request }) => {
    const token = readToken("contents-read");

    const list = await request.get("/api/manage/contents?kind=thread&size=100", {
      headers: bearer(token),
    });
    expect(list.status()).toBe(200);
    const listed = (await list.json()) as {
      data: { items: { postId: number; threadId: number; state: string }[]; total: number };
    };
    expect(listed.data.total).toBeGreaterThanOrEqual(FIX.minThreads);
    const fixtureRow = listed.data.items.find((i) => i.threadId === FIX.threadId);
    expect(fixtureRow, "夹具主题 951001 应在内容列表中").toMatchObject({
      postId: FIX.firstPostId,
      state: "visible",
    });

    const detail = await request.get(`/api/manage/contents/${FIX.threadId}?kind=thread`, {
      headers: bearer(token),
    });
    expect(detail.status()).toBe(200);
    expect(await detail.json()).toMatchObject({
      data: {
        kind: "thread",
        threadId: FIX.threadId,
        state: "visible",
        firstPost: { postId: FIX.firstPostId, state: "visible" },
      },
    });

    // kind=reply 按帖子 id 定位；首帖 id 回链主题。
    const reply = await request.get(`/api/manage/contents/${FIX.firstPostId}?kind=reply`, {
      headers: bearer(token),
    });
    expect(reply.status()).toBe(200);
    expect(await reply.json()).toMatchObject({
      data: { kind: "reply", postId: FIX.firstPostId, threadId: FIX.threadId, floor: 1 },
    });
  });

  test("查询语义 · 用户列表与详情断言夹具数据", async ({ request }) => {
    const token = readToken("users");

    const list = await request.get(`/api/manage/users?q=${FIX.username}&size=10`, {
      headers: bearer(token),
    });
    expect(list.status()).toBe(200);
    const listed = (await list.json()) as { data: { items: { id: number }[]; total: number } };
    expect(listed.data.total).toBeGreaterThanOrEqual(1);
    expect(listed.data.items.some((i) => i.id === FIX.userId)).toBe(true);

    const detail = await request.get(`/api/manage/users/${FIX.userId}`, { headers: bearer(token) });
    expect(detail.status()).toBe(200);
    expect(await detail.json()).toMatchObject({ data: { id: FIX.userId, username: FIX.username } });
  });

  test("查询语义 · 统计返回 30 日数据与演示库计数", async ({ request }) => {
    const stats = await request.get("/api/manage/stats", { headers: bearer(readToken("stats")) });
    expect(stats.status()).toBe(200);
    expect((await stats.json()).data).toMatchObject({
      registered30: expect.arrayContaining([expect.anything()]),
      todayLogins: expect.any(Number),
      totals: {
        users: expect.any(Number),
        threads: expect.any(Number),
        posts: expect.any(Number),
      },
    });
    const statsData = (await stats.json()).data as {
      registered30: unknown[];
      totals: { users: number; threads: number };
    };
    expect(statsData.registered30).toHaveLength(30);
    expect(statsData.totals.users).toBeGreaterThanOrEqual(FIX.minUsers);
    expect(statsData.totals.threads).toBeGreaterThanOrEqual(FIX.minThreads);
  });

  test("查询语义 · 审计按动作、操作者和目标类型找回实际签发记录", async ({ request }) => {
    const issued = readToken("identity");
    const actorId = adminUserIds[0]!;
    const audits = await request.get("/api/manage/audit-logs", {
      headers: bearer(readToken("audit-logs")),
      params: {
        action: "api_token.create",
        actor: actorId,
        targetType: "admin_api_token",
        size: 10,
      },
    });
    expect(audits.status()).toBe(200);
    const { data } = (await audits.json()) as {
      data: { items: { action: string; actorId: number; targetType: string }[]; total: number };
    };
    expect(data.total).toBeGreaterThanOrEqual(1);
    expect(data.items.every((i) => i.action === "api_token.create")).toBe(true);
    expect(
      data.items.every((i) => i.actorId === actorId && i.targetType === "admin_api_token"),
    ).toBe(true);
    expect(data.items).toContainEqual(
      expect.objectContaining({
        targetId: createHash("sha256").update(issued).digest("hex"),
        afterJson: expect.objectContaining({
          name: tokenName("identity", "read"),
          suffix: issued.slice(-8),
        }),
      }),
    );
  });

  test("查询语义 · 邮件与推送日志按合法场景筛出具名行及成败摘要", async ({ request }) => {
    const mailHeaders = bearer(readToken("emails"));
    const mailParams = { kind: "digest", scene: "digest", q: MAIL_RECIPIENT, size: 10 };
    const emails = await request.get("/api/manage/emails", {
      headers: mailHeaders,
      params: { ...mailParams, status: "sent" },
    });
    expect(emails.status()).toBe(200);
    const mail = (await emails.json()).data;
    expect(mail).toMatchObject({
      total: 1,
      items: [
        {
          id: namedRowIds.email,
          kind: "digest",
          scene: "digest",
          toEmail: MAIL_RECIPIENT,
          userId: FIX.userId,
          subject: READ_FIXTURE_NAME,
          status: "sent",
        },
      ],
      summary: { sent: expect.any(Number), failed: expect.any(Number) },
    });
    expect(mail.summary.sent).toBeGreaterThanOrEqual(1);
    const failedMail = await request.get("/api/manage/emails", {
      headers: mailHeaders,
      params: { ...mailParams, status: "failed" },
    });
    expect(failedMail.status()).toBe(200);
    expect(await failedMail.json()).toMatchObject({ data: { total: 0, items: [] } });

    const pushHeaders = bearer(readToken("push-logs"));
    const pushParams = { scene: "post-mentioned", q: PUSH_ENDPOINT, size: 10 };
    const pushes = await request.get("/api/manage/push-logs", {
      headers: pushHeaders,
      params: { ...pushParams, status: "failed" },
    });
    expect(pushes.status()).toBe(200);
    const push = (await pushes.json()).data;
    expect(push).toMatchObject({
      total: 1,
      items: [
        {
          id: namedRowIds.push,
          kind: "notice",
          scene: "post-mentioned",
          endpoint: PUSH_ENDPOINT,
          userId: FIX.userId,
          title: READ_FIXTURE_NAME,
          status: "failed",
          error: PUSH_ERROR,
        },
      ],
      summary: { sent: expect.any(Number), failed: expect.any(Number) },
    });
    expect(push.summary.failed).toBeGreaterThanOrEqual(1);
    const sentPush = await request.get("/api/manage/push-logs", {
      headers: pushHeaders,
      params: { ...pushParams, status: "sent" },
    });
    expect(sentPush.status()).toBe(200);
    expect(await sentPush.json()).toMatchObject({ data: { total: 0, items: [] } });
  });

  test("查询语义 · 举报列表与详情断言夹具数据", async ({ request }) => {
    const token = readToken("reports-read");

    const list = await request.get("/api/manage/reports?status=pending&size=10", {
      headers: bearer(token),
    });
    expect(list.status()).toBe(200);
    const listed = (await list.json()) as {
      data: { items: { id: number; status: string }[]; total: number };
    };
    expect(listed.data.total).toBeGreaterThanOrEqual(1);
    expect(listed.data.items.some((i) => i.id === detailTargets.reportId)).toBe(true);

    const detail = await request.get(`/api/manage/reports/${detailTargets.reportId}`, {
      headers: bearer(token),
    });
    expect(detail.status()).toBe(200);
    expect(await detail.json()).toMatchObject({
      data: { id: detailTargets.reportId, status: "pending", reason: "矩阵夹具举报" },
    });

    // 处置状态筛选：矩阵夹具保持 pending，resolved/dismissed 筛选不含它。
    const resolved = await request.get("/api/manage/reports?status=resolved&size=10", {
      headers: bearer(token),
    });
    expect(resolved.status()).toBe(200);
    const resolvedList = (await resolved.json()) as { data: { items: { id: number }[] } };
    expect(resolvedList.data.items.some((i) => i.id === detailTargets.reportId)).toBe(false);
  });

  test("查询语义 · 公告标题与窗口筛选、活动列表与详情返回具名数据", async ({ request }) => {
    const announcementHeaders = bearer(readToken("announcements-write"));
    const announcement = {
      id: detailTargets.announcementId,
      title: READ_FIXTURE_NAME,
      level: "important",
      audience: "members",
      status: "ended",
    };
    const ended = await request.get("/api/manage/announcements", {
      headers: announcementHeaders,
      params: { q: READ_FIXTURE_NAME, status: "ended", size: 10 },
    });
    expect(ended.status()).toBe(200);
    expect(await ended.json()).toMatchObject({ data: { total: 1, items: [announcement] } });
    const active = await request.get("/api/manage/announcements", {
      headers: announcementHeaders,
      params: { q: READ_FIXTURE_NAME, status: "active", size: 10 },
    });
    expect(active.status()).toBe(200);
    expect(await active.json()).toMatchObject({ data: { total: 0, items: [] } });
    const announcementDetail = await request.get(`/api/manage/announcements/${announcement.id}`, {
      headers: announcementHeaders,
    });
    expect(announcementDetail.status()).toBe(200);
    expect(await announcementDetail.json()).toMatchObject({
      data: { ...announcement, bodyMd: ANNOUNCEMENT_BODY },
    });

    const campaignHeaders = bearer(readToken("campaigns-write"));
    const campaign = {
      id: detailTargets.campaignId,
      name: READ_FIXTURE_NAME,
      effect: "theme.pack",
      target: "default",
      status: "disabled",
      enabled: false,
      invalid: false,
      revision: 1,
    };
    const campaigns = await request.get("/api/manage/campaigns", { headers: campaignHeaders });
    expect(campaigns.status()).toBe(200);
    expect(await campaigns.json()).toMatchObject({
      data: { items: expect.arrayContaining([expect.objectContaining(campaign)]) },
    });
    const campaignDetail = await request.get(`/api/manage/campaigns/${campaign.id}`, {
      headers: campaignHeaders,
    });
    expect(campaignDetail.status()).toBe(200);
    expect(await campaignDetail.json()).toMatchObject({ data: campaign });
  });

  test("查询语义 · 表情目录包含停用组及其关键词命中的停用表情", async ({ request }) => {
    const catalog = await request.get("/api/manage/emojis", {
      headers: bearer(readToken("emojis-write")),
      params: { groupId: namedRowIds.emojiGroup, q: EMOJI_KEYWORD, size: 10 },
    });
    expect(catalog.status()).toBe(200);
    expect(await catalog.json()).toMatchObject({
      data: {
        groups: expect.arrayContaining([
          expect.objectContaining({
            id: namedRowIds.emojiGroup,
            name: READ_FIXTURE_NAME,
            enabled: false,
            emojiCount: 1,
          }),
        ]),
        total: 1,
        items: [
          {
            id: namedRowIds.emoji,
            groupId: namedRowIds.emojiGroup,
            groupName: READ_FIXTURE_NAME,
            name: READ_FIXTURE_NAME,
            keywords: EMOJI_KEYWORD,
            enabled: false,
          },
        ],
      },
    });
  });

  test("错误路径 · 有校验的读查询逐字段返回 400", async ({ request }) => {
    // 各域用有权读取的本域令牌，避免把 400 探针集中到一枚全读令牌。
    const longValue = (name: string, max: number) => `${name}=${"x".repeat(max + 1)}`;
    const page = "page=0";
    const size = "size=999";
    const cases: [ProfileKey, string, ...string[]][] = [
      [
        "contents-read",
        "contents",
        "state=bogus",
        size,
        "kind=bogus",
        longValue("q", 128),
        "forumId=0",
        "order=bogus",
        page,
      ],
      ["contents-read", `contents/${FIX.threadId}`, "kind=bogus"],
      [
        "users",
        "users",
        "sort=bogus",
        "status=bogus",
        "lifecycle=bogus",
        "credential=bogus",
        longValue("q", 64),
        page,
        size,
      ],
      ["reports-read", "reports", "status=bogus", longValue("targetType", 32), page, size],
      ["announcements-write", "announcements", "status=bogus", longValue("q", 128), page, size],
      [
        "invites-write",
        "invites",
        "status=bogus",
        longValue("batch", 64),
        longValue("since", 10),
        longValue("until", 10),
        page,
        size,
      ],
      ["polls-write", "polls", "status=bogus", "forumId=0", page, size],
      [
        "points-write",
        "points/ledger",
        "",
        "userId=0",
        `userId=${FIX.userId}&${page}`,
        `userId=${FIX.userId}&${size}`,
      ],
      ["emojis-write", "emojis", "groupId=0", longValue("q", 64), page, size],
      ["settings-read", "settings", longValue("group", 64)],
      ["ops-read", "ops/runs", page, size],
      [
        "audit-logs",
        "audit-logs",
        "from=not-a-date",
        "to=not-a-date",
        longValue("action", 64),
        longValue("actor", 64),
        longValue("targetType", 32),
        page,
        size,
      ],
      [
        "emails",
        "emails",
        "status=bogus",
        "kind=bogus",
        "scene=bogus",
        longValue("q", 128),
        page,
        size,
      ],
      ["push-logs", "push-logs", "scene=bogus", "status=bogus", longValue("q", 128), page, size],
    ];
    for (const [profile, route, ...queries] of cases) {
      for (const query of queries) {
        const path = `/api/manage/${route}${query ? `?${query}` : ""}`;
        await expectManageError(
          await request.get(path, { headers: bearer(readToken(profile)) }),
          400,
          "bad_request",
        );
      }
    }
  });

  test("错误路径 · 合法但缺失的详情与畸形详情统一返回 404", async ({ request }) => {
    const cases: [ProfileKey, string, number | string, string, string?][] = [
      ["contents-read", "contents", MISSING_ID, "abc"],
      ["contents-read", "contents", MISSING_ID, "abc", "?kind=reply"],
      ["users", "users", MISSING_ID, "abc"],
      ["reports-read", "reports", MISSING_ID, "abc"],
      ["announcements-write", "announcements", MISSING_ID, "abc"],
      ["campaigns-write", "campaigns", MISSING_ID, "abc"],
      ["forums-write", "forums", MISSING_ID, "abc"],
      ["roles-read", "roles", writeTargets.roleKey, "bad_role"],
      ["themes-read", "themes", writeTargets.packId, "bad.pack"],
    ];
    for (const [profile, route, missing, malformed, query = ""] of cases) {
      for (const id of [missing, malformed]) {
        const path = `/api/manage/${route}/${id}${query}`;
        await expectManageError(
          await request.get(path, { headers: bearer(readToken(profile)) }),
          404,
          "not_found",
        );
      }
    }
    // 设置详情由查询参数选组，合法长度但不在白名单的组也是业务 404。
    await expectManageError(
      await request.get("/api/manage/settings", {
        headers: bearer(readToken("settings-read")),
        params: { group: writeTargets.group },
      }),
      404,
      "not_found",
    );
  });

  test("方法守卫 · 未登记的方法与路径不运行处理器", async ({ request }) => {
    const token = readToken("contents-write");
    // DELETE 未登记在审核端点 → 框架 405（处理器未运行、无副作用）；
    // 同文件内未登记方法转 404 的语义由 manage-api-guard 单元守卫覆盖。
    const removed = await request.delete("/api/manage/posts/1/review", {
      headers: bearer(token),
    });
    expect(removed.status()).toBe(405);
    // 未登记路径 → 框架 404（HTML 页面，非 API 信封）。
    const unknown = await request.get("/api/manage/not-a-real-endpoint", {
      headers: bearer(readToken("all-read")),
    });
    expect(unknown.status()).toBe(404);
  });
});
