import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { USERS, loginAs } from "./support/session";
import { withE2eDb } from "./support/db";
import {
  ADMIN_TOKENS,
  cleanupManageArtifacts,
  expectManageError,
  insertLegacyToken,
  issueManageToken,
  readFreshToken,
  revokeManageToken,
  seedPendingThread,
  type PendingThread,
} from "./support/manage-api";

const NAME_PREFIX = "E2E API 令牌 · ";
const REST_DOCS = "/docs/rest-api";

// 独立写出外部契约，不从被测权限目录或文档数据源生成期望。
const DOCUMENTED_ENDPOINTS = [
  ["GET", "/api/manage/whoami", "identity:read"],
  ["GET", "/api/manage/contents", "contents:read"],
  ["GET", "/api/manage/contents/{id}", "contents:read"],
  ["POST", "/api/manage/posts/{postId}/review", "contents:write"],
  ["POST", "/api/manage/posts/{postId}/hide", "contents:write"],
  ["POST", "/api/manage/posts/{postId}/disable", "contents:write"],
  ["POST", "/api/manage/posts/{postId}/restore", "contents:write"],
  ["PUT", "/api/manage/threads/{threadId}/lock", "contents:write"],
  ["PATCH", "/api/manage/threads/{threadId}/flags", "contents:write"],
  ["GET", "/api/manage/users", "users:read"],
  ["GET", "/api/manage/users/{uid}", "users:read"],
  ["GET", "/api/manage/reports", "reports:read"],
  ["GET", "/api/manage/reports/{reportId}", "reports:read"],
  ["POST", "/api/manage/reports/{reportId}/resolve", "reports:write"],
  ["POST", "/api/manage/reports/{reportId}/dismiss", "reports:write"],
  ["GET", "/api/manage/stats", "stats:read"],
  ["GET", "/api/manage/audit-logs", "audit-logs:read"],
  ["GET", "/api/manage/emails", "emails:read"],
  ["GET", "/api/manage/push-logs", "push-logs:read"],
] as const;

/** 按可访问表格行定位端点，避开概览和请求示例中的重复路径。 */
function endpointRows(page: Page) {
  return page
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: "请求", exact: true }) });
}

/** 定位单独的端点正文节；锚点名称由页面实际渲染的公开链接提供。 */
function endpointSection(page: Page, requestLine: string) {
  const row = endpointRows(page).filter({
    has: page.getByRole("cell", { name: requestLine, exact: true }),
  });
  return page.locator("section[id]").filter({ has: row });
}

/** 读取正文节目标的 hash，用于在可访问导航中查询对应链接。 */
async function endpointAnchor(section: ReturnType<typeof endpointSection>): Promise<string> {
  await expect(section).toHaveCount(1);
  await expect(section).toHaveAttribute("id", /^[a-z][a-z0-9-]+$/);
  return `#${await section.getAttribute("id")}`;
}

/** 清理本文件生成的台账，不删除其他用例或夹具中的令牌。 */
async function clearTokens(): Promise<void> {
  await withE2eDb((q) =>
    q.exec("DELETE FROM admin_api_tokens WHERE user_id = ? AND name LIKE ?", [
      USERS.admin,
      `${NAME_PREFIX}%`,
    ]),
  );
}

test("会员访问 API 令牌页 → 404（越权不暴露后台存在）", async ({ context, page }) => {
  await loginAs(context, USERS.member);
  expect((await page.goto(ADMIN_TOKENS))?.status()).toBe(404);
});

test("无凭证调用 /api/manage/whoami → 401（JSON 信封，不暴露页面语义）", async ({ request }) => {
  const resp = await request.get("/api/manage/whoami");
  expect(resp.status()).toBe(401);
  expect(await resp.json()).toEqual({
    error: { code: "unauthorized", message: "凭证缺失、无效或已失效。" },
  });
});

test("内容读写令牌：拒写 → 驳回通知与双重回放去重 → 锁定/解锁 → 吊销拒写", async ({
  context,
  page,
  request,
}) => {
  const runId = randomUUID();
  const marker = `E2E 管理写 ${runId}`;
  const names: [string, string, string] = [`${marker} 只读`, `${marker} 历史`, `${marker} 读写`];
  const target: PendingThread = { threadId: 0, postId: 0 };
  const sweepTarget: PendingThread = { threadId: 0, postId: 0 };
  let authorId = 0;
  let legacy = "";
  try {
    await loginAs(context, USERS.admin);
    const readOnly = await issueManageToken(page, names[0], { contents: "read" });
    const writer = await issueManageToken(page, names[2], {
      contents: "write",
      identity: "read",
    });
    await withE2eDb(async (q) => {
      // 被审核人用本次专用账号，避免向其他用例共用的账号发送通知。
      const username = `e2e-manage-${runId}`;
      authorId = (
        await q.exec(
          "INSERT INTO users (username, username_key, created_at) VALUES (?, ?, NOW())",
          [username, username],
        )
      ).insertId;
      await q.exec("INSERT INTO user_stats (user_id) VALUES (?)", [authorId]);
      await seedPendingThread(q, target, authorId, marker);
      legacy = await insertLegacyToken(q, USERS.admin, names[1]);
    });

    const { threadId, postId } = target;
    const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
    const readDetail = (token = writer, targetThreadId = threadId) =>
      request.get(`/api/manage/contents/${targetThreadId}?kind=thread`, { headers: bearer(token) });
    const readNotifications = () =>
      withE2eDb((q) =>
        q.query(
          `SELECT id, type, actor_id AS actorId, target_type AS targetType, target_id AS targetId,
                  JSON_UNQUOTE(JSON_EXTRACT(data, '$.reason')) AS reason
           FROM notifications WHERE user_id = ?`,
          [authorId],
        ),
      );
    const readOutbox = () =>
      withE2eDb((q) =>
        q.query<{ id: number; dispatchedAt: string | null; dispatchError: unknown }>(
          `SELECT id, dispatched_at AS dispatchedAt, dispatch_error AS dispatchError
           FROM event_outbox WHERE event_name = 'content.moderated' AND JSON_EXTRACT(payload, '$.postId') = ?`,
          [postId],
        ),
      );
    const identity = await request.get("/api/manage/whoami", { headers: bearer(writer) });
    expect(identity.status()).toBe(200);
    expect(await identity.json()).toMatchObject({
      ok: true,
      data: { user: { id: USERS.admin }, token: { name: names[2] } },
    });
    const detail = await readDetail();
    expect(detail.status()).toBe(200);
    const { data } = (await detail.json()) as { data: { firstPost: { editedAt: string } } };
    expect(data).toMatchObject({
      threadId,
      state: "pending",
      isLocked: false,
      firstPost: { postId, state: "pending" },
    });
    const { editedAt } = data.firstPost;
    expect(editedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    const reviewKey = randomUUID();
    const rejectionReason = "待补齐资料";
    const review = (
      token: string,
      {
        reason = rejectionReason,
        expectedEditedAt = editedAt,
        targetPostId = postId,
        key = reviewKey,
      }: {
        reason?: string;
        expectedEditedAt?: string | null;
        targetPostId?: number;
        key?: string;
      } = {},
    ) =>
      request.post(`/api/manage/posts/${targetPostId}/review`, {
        headers: { ...bearer(token), "Idempotency-Key": key },
        data: { decision: "reject", reason, expectedEditedAt },
      });
    const lock = (token: string, locked: boolean, key = randomUUID()) =>
      request.put(`/api/manage/threads/${threadId}/lock`, {
        headers: { ...bearer(token), "Idempotency-Key": key },
        data: { locked },
      });

    for (const restricted of [legacy, readOnly]) {
      expect((await readDetail(restricted)).status()).toBe(200);
      await expectManageError(await review(restricted), 403, "forbidden");
      await expectManageError(await lock(restricted, true), 403, "forbidden");
    }
    await expectManageError(
      await review(writer, { expectedEditedAt: null }),
      409,
      "state_conflict",
    );
    expect(await readNotifications(), "版本冲突不得发通知").toEqual([]);
    expect(await readOutbox(), "版本冲突不得入队").toEqual([]);

    const accepted = { ok: true, data: { postId, threadId, state: "rejected" } };
    const reviewed = await review(writer);
    expect(reviewed.status()).toBe(200);
    expect(await reviewed.json()).toEqual(accepted);
    const notifications = await readNotifications();
    expect(notifications).toEqual([
      {
        id: expect.any(Number),
        type: "content.rejected",
        actorId: USERS.admin,
        targetType: "post",
        targetId: postId,
        reason: rejectionReason,
      },
    ]);
    const outbox = await readOutbox();
    const dispatched = { dispatchedAt: expect.any(String), dispatchError: null };
    expect(outbox).toEqual([{ id: expect.any(Number), ...dispatched }]);
    const outboxId = outbox[0].id;
    const readReceipts = () =>
      withE2eDb((q) =>
        q.query("SELECT type, user_id AS userId FROM notification_receipts WHERE outbox_id = ?", [
          outboxId,
        ]),
      );
    const receipt = { type: "content.rejected", userId: authorId };
    expect(await readReceipts()).toEqual([receipt]);

    const replay = await review(writer);
    expect(replay.status()).toBe(200);
    expect(await replay.json()).toEqual(accepted);
    await expectManageError(
      await review(writer, { reason: "不同的驳回理由" }),
      409,
      "idempotency_conflict",
    );
    expect(await readNotifications(), "HTTP 回放不得改变站内通知").toEqual(notifications);
    expect(await readOutbox(), "HTTP 回放不得再次入队").toEqual(outbox);
    const reviews = await withE2eDb((q) =>
      q.query("SELECT decision, note FROM content_reviews WHERE post_id = ?", [postId]),
    );
    expect(reviews).toEqual([{ decision: "rejected", note: rejectionReason }]);

    // 用另一篇隔离待审帖触发正常审核后的巡检；管理员驳回自己的帖，不会额外发通知。
    await withE2eDb((q) => seedPendingThread(q, sweepTarget, USERS.admin, `${marker} 补派触发`));
    const sweepDetail = await readDetail(writer, sweepTarget.threadId);
    expect(sweepDetail.status()).toBe(200);
    const { data: sweepData } = (await sweepDetail.json()) as { data: typeof data };
    // 模拟通知已提交、但 outbox 还未来得及标记；不碰通知、凭证和其它事件。
    const reset = await withE2eDb((q) =>
      q.exec(
        "UPDATE event_outbox SET dispatched_at = NULL WHERE id = ? AND dispatched_at IS NOT NULL",
        [outboxId],
      ),
    );
    expect(reset.affectedRows).toBe(1);
    const trigger = await review(writer, {
      targetPostId: sweepTarget.postId,
      expectedEditedAt: sweepData.firstPost.editedAt,
      key: randomUUID(),
    });
    expect(trigger.status()).toBe(200);
    expect(await trigger.json()).toEqual({
      ok: true,
      data: { ...sweepTarget, state: "rejected" },
    });
    expect(await readOutbox(), "原 outbox 行须重新标记已派发").toEqual([
      { id: outboxId, ...dispatched },
    ]);
    const dispatches = await withE2eDb((q) =>
      q.query(
        `SELECT source, error_json AS errorJson FROM event_log
         WHERE event_name = 'content.moderated' AND JSON_EXTRACT(payload, '$.postId') = ? ORDER BY id`,
        [postId],
      ),
    );
    expect(dispatches).toEqual([
      { source: "moderation", errorJson: null },
      { source: "outbox", errorJson: null },
    ]);
    expect(await readNotifications(), "真实 outbox 补派后仍是原通知与原理由").toEqual(
      notifications,
    );
    expect(await readReceipts()).toEqual([receipt]);

    for (const locked of [true, false]) {
      const result = await lock(writer, locked);
      expect(result.status()).toBe(200);
      expect(await result.json()).toEqual({ ok: true, data: { threadId, locked, changed: true } });
      const confirmation = await readDetail();
      expect(confirmation.status()).toBe(200);
      expect(await confirmation.json()).toMatchObject({ data: { isLocked: locked } });
    }

    await revokeManageToken(page, names[2]);
    // 曾提交成功的同键回放也不能绕过吊销门禁。
    await expectManageError(await review(writer), 401, "unauthorized");
    await expectManageError(await lock(writer, true), 401, "unauthorized");
  } finally {
    await cleanupManageArtifacts({
      tokenNames: names,
      adminUserIds: [USERS.admin],
      authorUserIds: authorId ? [authorId] : [],
      targets: [target, sweepTarget],
    });
  }
});

test.describe("在线管理 REST 文档", () => {
  test("普通会员访问文档返回 404", async ({ context, page }) => {
    await loginAs(context, USERS.member);
    expect((await page.goto(REST_DOCS))?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "FunWind REST API", exact: true })).toHaveCount(
      0,
    );
  });

  test("未登录访问文档跳转登录页", async ({ page }) => {
    await page.goto(REST_DOCS);
    await expect(page).toHaveURL((url) => url.pathname === "/login");
    await expect(page.getByRole("heading", { name: "FunWind REST API", exact: true })).toHaveCount(
      0,
    );
  });

  test("管理员看到 19 个独立端点的请求方法、导航徽标和作用域", async ({ context, page }) => {
    await loginAs(context, USERS.admin);
    expect((await page.goto(REST_DOCS))?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "FunWind REST API", level: 1 })).toBeVisible();
    const nav = page.getByRole("navigation", { name: "文档导航", exact: true });
    await expect(nav).toBeVisible();
    await expect(endpointRows(page)).toHaveCount(DOCUMENTED_ENDPOINTS.length);
    for (const [method, path, scope] of DOCUMENTED_ENDPOINTS) {
      const section = endpointSection(page, `${method} ${path}`);
      const anchor = await endpointAnchor(section);
      const link = nav.getByRole("link").and(page.locator(`a[href="${anchor}"]`));
      await expect(link.getByText(method, { exact: true }), `${path} 的导航方法徽标`).toBeVisible();
      const scopeRow = section.getByRole("row").filter({
        has: page.getByRole("cell", { name: "令牌权限", exact: true }),
      });
      await expect(
        scopeRow.getByText(scope, { exact: true }),
        `${path} 的令牌作用域`,
      ).toBeVisible();
    }
  });

  test.describe("移动端", () => {
    test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

    test("点击文档抽屉的审核端点锚点，关闭抽屉并滚到正文", async ({ context, page }) => {
      await loginAs(context, USERS.admin);
      await page.goto(REST_DOCS);
      const section = endpointSection(page, "POST /api/manage/posts/{postId}/review");
      const anchor = await endpointAnchor(section);
      const navName = { name: "文档导航", exact: true };
      await page.getByRole("button", navName).click();
      const drawer = page.getByRole("dialog", navName);
      await expect(drawer).toBeVisible();
      await drawer
        .getByRole("navigation", navName)
        .getByRole("link")
        .and(page.locator(`a[href="${anchor}"]`))
        .click();
      await expect(page).toHaveURL((url) => url.pathname === REST_DOCS && url.hash === anchor);
      await expect(drawer).toBeHidden();
      await expect(section.getByRole("heading", { level: 3 })).toBeInViewport();
    });
  });
});

test.describe("管理员签发与授权", () => {
  test.beforeEach(async ({ context }) => {
    await clearTokens();
    await loginAs(context, USERS.admin);
  });
  test.afterEach(clearTokens);

  test("仅签发身份读权 → 明文仅展示一次 → 跨域 403 → 吊销后 401", async ({ page, request }) => {
    const name = `${NAME_PREFIX}身份`;
    await page.goto(ADMIN_TOKENS);
    await expect(page.getByText("签发新 Token")).toBeVisible();
    await expect(page.getByLabel("有效期")).toHaveValue("90");
    await page.getByLabel("名称（便于辨识用途）").fill(name);
    await page.getByLabel("令牌身份", { exact: true }).selectOption("read");
    await page.getByRole("button", { name: "签发", exact: true }).click();

    const plain = await readFreshToken(page);
    const headers = { authorization: `Bearer ${plain}` };
    const ok = await request.get("/api/manage/whoami", { headers });
    expect(ok.status()).toBe(200);
    const body = (await ok.json()) as {
      ok: boolean;
      data: { user: { id: number }; token: { name: string }; tokenPermissions?: unknown };
    };
    expect(body.ok).toBe(true);
    expect(body.data.user.id).toBe(USERS.admin);
    expect(body.data.token.name).toBe(name);
    expect(body.data).not.toHaveProperty("tokenPermissions");

    const denied = await request.get("/api/manage/stats", { headers });
    expect(denied.status()).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: "forbidden" } });

    // 刷新带回执的页面不重放明文，凭证仍可调用。
    await page.reload();
    await expect(page.getByTestId("fresh-token")).toHaveCount(0);
    const diagnostic = await request.get("/api/manage/whoami?include=token_permissions", {
      headers,
    });
    expect(diagnostic.status()).toBe(200);
    const identityGrant = {
      id: "whoami",
      method: "GET",
      path: "/api/manage/whoami",
      scope: "identity:read",
    };
    expect(await diagnostic.json()).toMatchObject({
      data: { tokenPermissions: { granted: [identityGrant], effective: [identityGrant] } },
    });

    const row = page.getByRole("row").filter({ hasText: name });
    await expect(row).toContainText(plain.slice(-8));
    const detail = row.locator("details");
    await expect(detail).toHaveJSProperty("open", false);
    await detail.locator("summary").click();
    await expect(detail.locator("code")).toHaveText(["GET /api/manage/whoami"]);

    await row.getByRole("button", { name: "吊销" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "确认" }).click();
    await expect(page.getByText("Token 已吊销，使用它的调用即刻失效（401）。")).toBeVisible();
    expect((await request.get("/api/manage/whoami", { headers })).status()).toBe(401);
    await expect(row).toContainText("已吊销");
    await expect(row.getByRole("button", { name: "吊销" })).toHaveCount(0);
  });

  test("旧版只展示冻结九读；异常快照无端点且仍能吊销", async ({ page }) => {
    const legacyName = `${NAME_PREFIX}旧版`;
    const invalidName = `${NAME_PREFIX}异常`;
    await withE2eDb(async (q) => {
      for (const [name, prefix, profile, snapshot] of [
        [legacyName, "fw_at_", "legacy_m20_read", null],
        [invalidName, "fw_at2_", "scoped_v2", "[]"],
      ] as const) {
        const plain = prefix + randomBytes(32).toString("base64url");
        await q.exec(
          `INSERT INTO admin_api_tokens
             (id, user_id, name, suffix, created_at, expires_at, permission_profile, permission_snapshot)
           VALUES (?, ?, ?, ?, NOW(), NOW() + INTERVAL 1 DAY, ?, ?)`,
          [
            createHash("sha256").update(plain).digest("hex"),
            USERS.admin,
            name,
            plain.slice(-8),
            profile,
            snapshot,
          ],
        );
      }
    });

    await page.goto(ADMIN_TOKENS);
    const legacy = page.getByRole("row").filter({ hasText: legacyName }).locator("details");
    await expect(legacy).toHaveJSProperty("open", false);
    await legacy.locator("summary").click();
    await expect(legacy.locator("code")).toHaveText([
      "GET /api/manage/whoami",
      "GET /api/manage/contents",
      "GET /api/manage/contents/{id}",
      "GET /api/manage/users",
      "GET /api/manage/users/{uid}",
      "GET /api/manage/stats",
      "GET /api/manage/audit-logs",
      "GET /api/manage/emails",
      "GET /api/manage/push-logs",
    ]);

    const invalid = page.getByRole("row").filter({ hasText: invalidName });
    await expect(invalid).toContainText("授权异常");
    await expect(invalid).not.toContainText("生效中");
    await expect(invalid.locator("details")).toHaveCount(0);
    await invalid.getByRole("button", { name: "吊销" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "确认" }).click();
    await expect(invalid).toContainText("已吊销");
  });

  test.describe("无 JavaScript 的窄屏表单", () => {
    test.use({ javaScriptEnabled: false, viewport: { width: 320, height: 812 } });

    test("默认全禁拒绝签发，选择内容只读后仅获该域两读", async ({ page, request }) => {
      const name = `${NAME_PREFIX}无脚本`;
      await page.goto(ADMIN_TOKENS);
      const matrix = page.getByRole("group", { name: "权限矩阵" });
      const levels = matrix.getByRole("combobox");
      await expect(levels).toHaveCount(8);
      for (const level of await levels.all()) await expect(level).toHaveValue("none");
      const identity = matrix.getByLabel("令牌身份", { exact: true });
      await expect(identity.locator('option[value="write"]')).toBeDisabled();
      await expect(identity).toHaveAccessibleDescription("尚无写端点。");

      const nameField = page.getByLabel("名称（便于辨识用途）");
      const issue = page.getByRole("button", { name: "签发", exact: true });
      await nameField.fill(name);
      await issue.click();
      await expect(page.getByText("请选择至少一项可用的令牌权限。", { exact: true })).toBeVisible();
      await expect(page.getByTestId("fresh-token")).toHaveCount(0);
      await expect(page.getByRole("row").filter({ hasText: name })).toHaveCount(0);

      await nameField.fill(name);
      await matrix.getByLabel("内容治理", { exact: true }).selectOption("read");
      await issue.click();
      const plain = await readFreshToken(page);
      const headers = { authorization: `Bearer ${plain}` };
      const detail = page.getByRole("row").filter({ hasText: name }).locator("details");
      await detail.locator("summary").click();
      await expect(detail.locator("code")).toHaveText([
        "GET /api/manage/contents",
        "GET /api/manage/contents/{id}",
      ]);
      expect((await request.get("/api/manage/contents", { headers })).status()).toBe(200);
      expect((await request.get("/api/manage/whoami", { headers })).status()).toBe(403);
    });
  });
});
