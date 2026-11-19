import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, type APIResponse, type Page } from "@playwright/test";
import { withE2eDb, type Q } from "./db";

/**
 * 管理 REST 验收夹具（E2E 公共支持）。
 *
 * 这里独立写出对外契约（域、方法、路径、标签），不从被测的权限目录或文档数据源生成期望，
 * 避免实现与断言同源而互相掩盖。
 */

export const ADMIN_TOKENS = "/admin/api-tokens";

/** 后台矩阵的域标签（与页面可访问名称一致）。 */
export const DOMAIN_LABELS = {
  identity: "令牌身份",
  contents: "内容治理",
  users: "用户管理",
  reports: "举报处理",
  stats: "站点统计",
  "audit-logs": "审计日志",
  emails: "邮件日志",
  "push-logs": "推送日志",
} as const;

export type ManageDomain = keyof typeof DOMAIN_LABELS;
export type ManageLevel = "none" | "read" | "write";

/** 管理端点的对外契约：域、方法、路径；写端点附矩阵探测用的合法示例请求体。 */
export const REST_ENDPOINTS = [
  { domain: "identity", method: "GET", path: "/api/manage/whoami" },
  { domain: "contents", method: "GET", path: "/api/manage/contents" },
  { domain: "contents", method: "GET", path: "/api/manage/contents/{id}" },
  {
    domain: "contents",
    method: "POST",
    path: "/api/manage/posts/{postId}/review",
    sampleBody: { decision: "approve", expectedEditedAt: null },
  },
  {
    domain: "contents",
    method: "PUT",
    path: "/api/manage/threads/{threadId}/lock",
    sampleBody: { locked: true },
  },
  {
    domain: "contents",
    method: "POST",
    path: "/api/manage/posts/{postId}/hide",
    sampleBody: { expectedEditedAt: null, reason: "probe" },
  },
  {
    domain: "contents",
    method: "POST",
    path: "/api/manage/posts/{postId}/disable",
    sampleBody: { expectedEditedAt: null, reason: "probe" },
  },
  {
    domain: "contents",
    method: "POST",
    path: "/api/manage/posts/{postId}/restore",
    sampleBody: { expectedEditedAt: null },
  },
  {
    domain: "contents",
    method: "PATCH",
    path: "/api/manage/threads/{threadId}/flags",
    sampleBody: { featured: true },
  },
  { domain: "users", method: "GET", path: "/api/manage/users" },
  { domain: "users", method: "GET", path: "/api/manage/users/{uid}" },
  {
    domain: "users",
    method: "POST",
    path: "/api/manage/users/{uid}/restrictions",
    sampleBody: { kind: "mute", reason: "probe", endsAt: null },
  },
  {
    domain: "users",
    method: "DELETE",
    path: "/api/manage/users/{uid}/restrictions/{restrictionId}",
    sampleBody: { note: "probe" },
  },
  {
    domain: "users",
    method: "DELETE",
    path: "/api/manage/users/{uid}/sessions/{sessionId}",
    sampleBody: {},
  },
  {
    domain: "users",
    method: "POST",
    path: "/api/manage/users/{uid}/appeals/{appealId}/resolve",
    sampleBody: { status: "approved", result: "probe" },
  },
  { domain: "reports", method: "GET", path: "/api/manage/reports" },
  { domain: "reports", method: "GET", path: "/api/manage/reports/{reportId}" },
  {
    domain: "reports",
    method: "POST",
    path: "/api/manage/reports/{reportId}/resolve",
    sampleBody: { note: "probe" },
  },
  {
    domain: "reports",
    method: "POST",
    path: "/api/manage/reports/{reportId}/dismiss",
    sampleBody: { note: "probe" },
  },
  { domain: "stats", method: "GET", path: "/api/manage/stats" },
  { domain: "audit-logs", method: "GET", path: "/api/manage/audit-logs" },
  { domain: "emails", method: "GET", path: "/api/manage/emails" },
  { domain: "push-logs", method: "GET", path: "/api/manage/push-logs" },
] as const;

/** 读端点用于逐域授权核对；写端点用不存在的目标，避免矩阵核对产生真实副作用。 */
export const READ_ENDPOINTS = REST_ENDPOINTS.filter((e) => e.method === "GET");
export const WRITE_ENDPOINTS = REST_ENDPOINTS.filter((e) => e.method !== "GET");

/** 不存在的目标 id：授权通过后应得 404，被拒绝时应得 403。 */
export const MISSING_ID = 999999999;

/**
 * 把契约路径的 `{...}` 占位符统一替换为目标 id。
 * 停写门禁在参数解析之前就返回 503（门禁先于 handler），因此探测目标值不影响断言。
 */
export function fillEndpointPath(path: string, id: number | string = 1): string {
  return path.replace(/\{[^}]+\}/g, String(id));
}

export function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

/** 读取签发页仅出现一次的新版明文，并核对格式。 */
export async function readFreshToken(page: Page): Promise<string> {
  const fresh = page.getByTestId("fresh-token");
  await expect(fresh).toBeVisible();
  const plain = (await fresh.locator("code").textContent())?.trim() ?? "";
  expect(plain).toMatch(/^fw_at2_[A-Za-z0-9_-]{43}$/);
  return plain;
}

/** 经后台页面按域签发令牌：走真实表单与服务端二次校验。 */
export async function issueManageToken(
  page: Page,
  name: string,
  levels: Partial<Record<ManageDomain, ManageLevel>>,
): Promise<string> {
  await page.goto(ADMIN_TOKENS);
  const matrix = page.getByRole("group", { name: "权限矩阵" });
  await page.getByLabel("名称（便于辨识用途）").fill(name);
  for (const [domain, level] of Object.entries(levels)) {
    await matrix
      .getByLabel(DOMAIN_LABELS[domain as ManageDomain], { exact: true })
      .selectOption(level);
  }
  await page.getByRole("button", { name: "签发", exact: true }).click();
  return readFreshToken(page);
}

/** 经后台页面吊销令牌（走真实确认对话框）。名称按单元格精确匹配，避免前缀相近的令牌串行。 */
export async function revokeManageToken(page: Page, name: string): Promise<void> {
  await page.goto(ADMIN_TOKENS);
  await page
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name, exact: true }) })
    .getByRole("button", { name: "吊销" })
    .click();
  await page.getByRole("dialog").getByRole("button", { name: "确认" }).click();
  await expect(page.getByText("Token 已吊销，使用它的调用即刻失效（401）。")).toBeVisible();
}

/** 核对拒绝来自管理 REST 门禁的统一信封，而不是框架跳转或通用错误页。 */
export async function expectManageError(
  response: APIResponse,
  status: number,
  code: string,
): Promise<void> {
  expect(response.status(), response.url()).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code } });
}

export type PendingThread = { threadId: number; postId: number };

/** 在演示审核版块创建首帖（默认待审，可指定可见/已删供迁移类用例）；逐步记录主键。 */
export async function seedPendingThread(
  q: Q,
  target: PendingThread,
  authorId: number,
  text: string,
  state: "pending" | "visible" | "deleted" = "pending",
): Promise<PendingThread> {
  target.threadId = (
    await q.exec(
      `INSERT INTO threads (forum_id, author_id, title, state, created_at, last_posted_at)
       VALUES (906, ?, ?, ?, NOW(), NOW())`,
      [authorId, text, state],
    )
  ).insertId;
  target.postId = (
    await q.exec(
      `INSERT INTO posts (thread_id, floor, author_id, body_md, state, created_at, edited_at)
       VALUES (?, 1, ?, ?, ?, NOW(), NOW())`,
      [target.threadId, authorId, text, state],
    )
  ).insertId;
  await q.exec("UPDATE threads SET first_post_id = ? WHERE id = ?", [
    target.postId,
    target.threadId,
  ]);
  return target;
}

/**
 * 创建本次专用的站点管理员：复用演示管理员的密码哈希，绑定 admin 角色。
 * 令牌上限按持有人计（每管理员 5 枚），因此矩阵核对需要分散到多个专用管理员。
 */
export async function createAdminUser(q: Q, tag: string): Promise<number> {
  const username = `e2e-manage-admin-${tag}`;
  const userId = (
    await q.exec(
      `INSERT INTO users (username, username_key, email, email_key, password_hash, state, created_at, email_verified_at)
       SELECT ?, ?, ?, ?, password_hash, 'active', NOW(), NOW() FROM users WHERE id = 90004`,
      [username, username, `${username}@test.local`, `${username}@test.local`],
    )
  ).insertId;
  await q.exec("INSERT INTO user_stats (user_id) VALUES (?)", [userId]);
  await q.exec(
    "INSERT INTO user_roles (user_id, role_key, scope_id, granted_at) VALUES (?, 'admin', 0, NOW())",
    [userId],
  );
  return userId;
}

/** 造一个只用于接收审核通知的作者账号，避免通知发给共用账号。 */
export async function createAuthorUser(q: Q, tag: string): Promise<number> {
  const username = `e2e-manage-author-${tag}`;
  const userId = (
    await q.exec("INSERT INTO users (username, username_key, created_at) VALUES (?, ?, NOW())", [
      username,
      username,
    ])
  ).insertId;
  await q.exec("INSERT INTO user_stats (user_id) VALUES (?)", [userId]);
  return userId;
}

/** 造一枚历史九读令牌（明文前缀与旧版一致，授权模型为 legacy_m20_read）。 */
export async function insertLegacyToken(q: Q, userId: number, name: string): Promise<string> {
  const plain = `fw_at_${randomBytes(32).toString("base64url")}`;
  await q.exec(
    `INSERT INTO admin_api_tokens
       (id, user_id, name, suffix, created_at, expires_at, permission_profile, permission_snapshot)
     VALUES (?, ?, ?, ?, NOW(), NOW() + INTERVAL 1 DAY, 'legacy_m20_read', NULL)`,
    [createHash("sha256").update(plain).digest("hex"), userId, name, plain.slice(-8)],
  );
  return plain;
}

/** 删除本次验收产生的令牌、幂等记录、审计、内容、通知与账号。 */
export async function cleanupManageArtifacts(input: {
  tokenNames: readonly string[];
  adminUserIds: readonly number[];
  authorUserIds: readonly number[];
  targets: readonly PendingThread[];
}): Promise<void> {
  await withE2eDb(async (q) => {
    if (input.tokenNames.length > 0) {
      const tokens = await q.query<{ id: string; suffix: string }>(
        `SELECT id, suffix FROM admin_api_tokens WHERE name IN (${input.tokenNames.map(() => "?").join(",")})`,
        input.tokenNames as unknown[],
      );
      for (const { id, suffix } of tokens) {
        await q.exec("DELETE FROM manage_api_idempotency WHERE token_id = ?", [id]);
        const actorFilter =
          input.adminUserIds.length > 0
            ? `actor_id IN (${input.adminUserIds.map(() => "?").join(",")}) AND `
            : "";
        await q.exec(
          `DELETE FROM audit_log WHERE ${actorFilter}
             ((target_type = 'admin_api_token' AND target_id = ?)
               OR (target_type = 'manage_api' AND BINARY JSON_UNQUOTE(JSON_EXTRACT(after_json, '$.tokenSuffix')) = ?))`,
          [...input.adminUserIds, id, suffix],
        );
        await q.exec("DELETE FROM admin_api_tokens WHERE id = ?", [id]);
      }
    }
    for (const { postId, threadId } of input.targets) {
      if (postId) {
        for (const table of ["notification_receipts", "notification_deliveries"]) {
          await q.exec(
            `DELETE n FROM ${table} n JOIN event_outbox o ON o.id = n.outbox_id
             WHERE o.event_name IN ('content.moderated', 'thread.replied')
               AND JSON_EXTRACT(o.payload, '$.postId') = ?`,
            [postId],
          );
        }
        await q.exec("DELETE FROM notifications WHERE target_type = 'post' AND target_id = ?", [
          postId,
        ]);
        for (const table of ["event_log", "event_outbox"]) {
          await q.exec(
            `DELETE FROM ${table} WHERE event_name IN ('content.moderated', 'thread.replied')
               AND JSON_EXTRACT(payload, '$.postId') = ?`,
            [postId],
          );
        }
        await q.exec("DELETE FROM content_reviews WHERE post_id = ?", [postId]);
        await q.exec("DELETE FROM audit_log WHERE target_type = 'post' AND target_id = ?", [
          String(postId),
        ]);
        await q.exec("DELETE FROM posts WHERE id = ?", [postId]);
      }
      if (threadId) {
        await q.exec("DELETE FROM audit_log WHERE target_type = 'thread' AND target_id = ?", [
          String(threadId),
        ]);
        await q.exec("DELETE FROM threads WHERE id = ?", [threadId]);
      }
    }
    for (const userId of input.authorUserIds) {
      if (!userId) continue;
      await q.exec("DELETE FROM notifications WHERE user_id = ?", [userId]);
      await q.exec("DELETE FROM user_stats WHERE user_id = ?", [userId]);
      await q.exec("DELETE FROM user_roles WHERE user_id = ?", [userId]);
      await q.exec("DELETE FROM users WHERE id = ?", [userId]);
    }
  });
}

/** 一次性运行编号，用于区分本次验收产生的行。 */
export function runTag(): string {
  return randomUUID().slice(0, 8);
}
