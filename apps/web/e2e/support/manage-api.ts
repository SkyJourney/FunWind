import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, type APIResponse, type FullConfig, type Page } from "@playwright/test";
import { loginAs } from "./session";
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
  forums: "版块管理",
  polls: "投票",
  pm: "私信",
  badges: "徽章",
  points: "积分",
  emojis: "表情",
  roles: "角色权限",
  settings: "站点设置",
  ops: "运维任务",
  themes: "主题包",
  announcements: "公告",
  campaigns: "活动",
  invites: "邀请码",
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
  {
    domain: "announcements",
    method: "GET",
    path: "/api/manage/announcements",
  },
  {
    domain: "announcements",
    method: "GET",
    path: "/api/manage/announcements/{announcementId}",
  },
  {
    domain: "announcements",
    method: "POST",
    path: "/api/manage/announcements",
    expectedStatus: 200,
    sampleBody: (tag: string) => ({
      title: tag,
      bodyMd: "",
      level: "info",
      audience: "members",
      showBanner: false,
      startsAt: "2000-01-01 00:00:00",
      endsAt: "2000-01-02 00:00:00",
    }),
  },
  {
    domain: "announcements",
    method: "PATCH",
    path: "/api/manage/announcements/{announcementId}",
    sampleBody: {
      title: "probe",
      bodyMd: "",
      level: "info",
      audience: "all",
      showBanner: false,
      startsAt: null,
      endsAt: null,
    },
  },
  {
    domain: "announcements",
    method: "POST",
    path: "/api/manage/announcements/{announcementId}/end",
    sampleBody: {},
  },
  { domain: "campaigns", method: "GET", path: "/api/manage/campaigns" },
  { domain: "campaigns", method: "GET", path: "/api/manage/campaigns/{campaignId}" },
  {
    domain: "campaigns",
    method: "POST",
    path: "/api/manage/campaigns",
    expectedStatus: 200,
    sampleBody: (tag: string) => ({
      name: tag,
      effect: "theme.pack",
      target: "default",
      startsAt: "2000-01-01 00:00:00",
      endsAt: "2000-01-02 00:00:00",
      priority: 0,
    }),
  },
  {
    domain: "campaigns",
    method: "PATCH",
    path: "/api/manage/campaigns/{campaignId}",
    sampleBody: {
      expectedRevision: 1,
      name: "probe",
      effect: "theme.pack",
      target: "default",
      startsAt: "2026-01-01 00:00:00",
      endsAt: null,
      priority: 0,
    },
  },
  {
    domain: "campaigns",
    method: "POST",
    path: "/api/manage/campaigns/{campaignId}/enabled",
    sampleBody: { enabled: true },
  },
  { domain: "invites", method: "GET", path: "/api/manage/invites" },
  {
    domain: "invites",
    method: "POST",
    path: "/api/manage/invites",
    expectedStatus: 200,
    sampleBody: (tag: string) => ({ count: 1, days: 30, batch: tag }),
  },
  {
    domain: "invites",
    method: "DELETE",
    path: "/api/manage/invites/{code}",
    sampleBody: {},
  },
  {
    domain: "invites",
    method: "POST",
    path: "/api/manage/invites/batches/{batch}/revoke",
    sampleBody: {},
  },
  { domain: "forums", method: "GET", path: "/api/manage/forums" },
  { domain: "forums", method: "GET", path: "/api/manage/forums/{fid}" },
  {
    domain: "forums",
    method: "POST",
    path: "/api/manage/forums",
    sampleBody: {
      parentId: 999999999,
      kind: "forum",
      name: "probe",
      description: null,
      sortOrder: 0,
      isListed: true,
    },
  },
  {
    domain: "forums",
    method: "PATCH",
    path: "/api/manage/forums/{fid}",
    sampleBody: {
      parentId: 999999999,
      name: "probe",
      description: null,
      sortOrder: 0,
      isListed: true,
      readPolicy: "inherit",
      writePolicy: "inherit",
      reviewPolicy: "inherit",
      isArchived: false,
    },
  },
  {
    domain: "forums",
    method: "DELETE",
    path: "/api/manage/forums/{fid}",
    sampleBody: {},
  },
  {
    domain: "forums",
    method: "POST",
    path: "/api/manage/forums/{fid}/prefixes",
    sampleBody: { name: "probe", sortOrder: 0 },
  },
  {
    domain: "forums",
    method: "DELETE",
    path: "/api/manage/forums/{fid}/prefixes/{prefixId}",
    sampleBody: {},
  },
  { domain: "polls", method: "GET", path: "/api/manage/polls" },
  {
    domain: "polls",
    method: "POST",
    path: "/api/manage/polls/{threadId}/close",
    sampleBody: {},
  },
  {
    domain: "polls",
    method: "POST",
    path: "/api/manage/polls/{threadId}/reopen",
    sampleBody: {},
  },
  {
    domain: "polls",
    method: "DELETE",
    path: "/api/manage/polls/{threadId}",
    sampleBody: {},
  },
  {
    domain: "pm",
    method: "DELETE",
    path: "/api/manage/pm/messages/{messageId}",
    sampleBody: { reason: "probe" },
  },
  { domain: "badges", method: "GET", path: "/api/manage/badges" },
  {
    domain: "badges",
    method: "POST",
    path: "/api/manage/users/{uid}/badges/{badgeId}",
    sampleBody: {},
  },
  {
    domain: "badges",
    method: "DELETE",
    path: "/api/manage/users/{uid}/badges/{badgeId}",
    sampleBody: {},
  },
  { domain: "points", method: "GET", path: "/api/manage/points/ledger" },
  { domain: "points", method: "GET", path: "/api/manage/points/rules" },
  {
    domain: "points",
    method: "POST",
    path: "/api/manage/points/adjustments",
    sampleBody: { userId: 999999999, delta: 1, note: "probe" },
  },
  { domain: "emojis", method: "GET", path: "/api/manage/emojis" },
  {
    domain: "emojis",
    method: "POST",
    path: "/api/manage/emoji-groups",
    expectedStatus: 200,
    sampleBody: (tag: string) => ({ name: tag }),
  },
  {
    domain: "emojis",
    method: "PATCH",
    path: "/api/manage/emoji-groups/{groupId}",
    sampleBody: { name: "probe" },
  },
  {
    domain: "emojis",
    method: "POST",
    path: "/api/manage/emoji-groups/{groupId}/enabled",
    sampleBody: { enabled: true },
  },
  {
    domain: "emojis",
    method: "DELETE",
    path: "/api/manage/emoji-groups/{groupId}",
    sampleBody: {},
  },
  {
    domain: "emojis",
    method: "POST",
    path: "/api/manage/emoji-groups/{groupId}/sort",
    sampleBody: { sort: 1 },
  },
  {
    domain: "emojis",
    method: "PATCH",
    path: "/api/manage/emojis/{emojiId}",
    sampleBody: { name: "probe", keywords: "", sort: 1 },
  },
  {
    domain: "emojis",
    method: "POST",
    path: "/api/manage/emojis/{emojiId}/enabled",
    sampleBody: { enabled: true },
  },
  { domain: "roles", method: "GET", path: "/api/manage/roles" },
  { domain: "roles", method: "GET", path: "/api/manage/roles/{roleKey}" },
  {
    domain: "roles",
    method: "POST",
    path: "/api/manage/roles",
    expectedStatus: 200,
    sampleBody: (tag: string) => ({ key: tag, name: tag }),
  },
  {
    domain: "roles",
    method: "DELETE",
    path: "/api/manage/roles/{roleKey}",
    sampleBody: {},
  },
  {
    domain: "roles",
    method: "PUT",
    path: "/api/manage/roles/{roleKey}/grants/{permission}",
    sampleBody: { scopeId: 0 },
  },
  {
    domain: "roles",
    method: "DELETE",
    path: "/api/manage/roles/{roleKey}/grants/{permission}",
    sampleBody: { scopeId: 0 },
  },
  {
    domain: "roles",
    method: "PUT",
    path: "/api/manage/users/{uid}/roles/{roleKey}",
    sampleBody: { scopeId: 0, reason: "probe", expiresAt: null },
  },
  {
    domain: "roles",
    method: "DELETE",
    path: "/api/manage/users/{uid}/roles/{roleKey}",
    expectedStatus: 200,
    sampleBody: { scopeId: 0, reason: "probe" },
  },
  { domain: "settings", method: "GET", path: "/api/manage/settings" },
  {
    domain: "settings",
    method: "PATCH",
    path: "/api/manage/settings/{group}",
    sampleBody: {},
  },
  { domain: "ops", method: "GET", path: "/api/manage/ops/tasks" },
  { domain: "ops", method: "GET", path: "/api/manage/ops/runs" },
  {
    domain: "ops",
    method: "POST",
    path: "/api/manage/ops/tasks/{taskKey}/trigger",
    sampleBody: {},
  },
  {
    domain: "ops",
    method: "PATCH",
    path: "/api/manage/ops/tasks/{taskKey}/enabled",
    sampleBody: { enabled: true },
  },
  {
    domain: "ops",
    method: "PATCH",
    path: "/api/manage/ops/tasks/{taskKey}/params",
    sampleBody: { expectedRevision: 1, params: { keep: 14 } },
  },
  { domain: "themes", method: "GET", path: "/api/manage/themes" },
  { domain: "themes", method: "GET", path: "/api/manage/themes/{packId}" },
  {
    domain: "themes",
    method: "PATCH",
    path: "/api/manage/themes/{packId}",
    sampleBody: { expectedRevision: 1, name: "probe" },
  },
  {
    domain: "themes",
    method: "POST",
    path: "/api/manage/themes/{packId}/enabled",
    sampleBody: { enabled: true },
  },
  { domain: "stats", method: "GET", path: "/api/manage/stats" },
  { domain: "audit-logs", method: "GET", path: "/api/manage/audit-logs" },
  { domain: "emails", method: "GET", path: "/api/manage/emails" },
  { domain: "push-logs", method: "GET", path: "/api/manage/push-logs" },
] as const;

/** 授权通过的写探测默认使用不存在的目标，少数集合创建和无变更操作另行声明预期状态。 */
export const READ_ENDPOINTS = REST_ENDPOINTS.filter((e) => e.method === "GET");
export const WRITE_ENDPOINTS = REST_ENDPOINTS.filter((e) => e.method !== "GET");
export const READ_DOMAINS = [...new Set(READ_ENDPOINTS.map((endpoint) => endpoint.domain))];
export const WRITE_DOMAINS = [...new Set(WRITE_ENDPOINTS.map((endpoint) => endpoint.domain))];

/** 不存在的数字主键，用于区分授权放行与权限拒绝。 */
export const MISSING_ID = 999999999;

/** 填入符合路径格式的目标。停写门禁在解析这些参数之前返回。 */
export function fillEndpointPath(
  path: string,
  values: Readonly<Record<string, number | string>> = {},
): string {
  return path.replace(/\{([^}]+)\}/g, (_, key: string) =>
    encodeURIComponent(String(values[key] ?? MISSING_ID)),
  );
}

/** 确认隔离服务由验收启动，且生产构建与运行进程都显式清空运维连接。 */
export function expectOpsPipelineDisconnected(config: FullConfig): void {
  const server = config.webServer;
  expect(server?.reuseExistingServer === false, "运维验收必须由当前配置启动隔离服务").toBe(true);
  for (const key of [
    "OPS_SERVICE_URL",
    "OPS_API_TOKEN",
    "BACKUP_SERVICE_URL",
    "BACKUP_OPS_TOKEN",
  ]) {
    expect(server?.env?.[key] === "", `隔离服务须在启动配置中显式清空 ${key}`).toBe(true);
  }
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
  holder?: number,
): Promise<string> {
  if (holder !== undefined) await loginAs(page.context(), holder);
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

/** 默认沿用演示版块的待审夹具；会改变可见性计数的用例须传入专属版块。 */
export async function seedPendingThread(
  q: Q,
  target: PendingThread,
  authorId: number,
  text: string,
  state: "pending" | "visible" | "deleted" = "pending",
  forumId = 906,
): Promise<PendingThread> {
  if (state !== "pending" && forumId === 906) {
    throw new Error("可见或恢复类内容夹具必须使用专属版块");
  }
  target.threadId = (
    await q.exec(
      `INSERT INTO threads (forum_id, author_id, title, state, created_at, last_posted_at)
       VALUES (?, ?, ?, ?, NOW(), NOW())`,
      [forumId, authorId, text, state],
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
  if (state === "visible") {
    // 直插可见首帖时同步派生值，后续屏蔽才能在正确基线上减计数。
    await q.exec(
      `UPDATE threads t JOIN posts p ON p.id = t.first_post_id
       SET t.last_post_id = p.id, t.last_poster_id = p.author_id, t.last_posted_at = p.created_at
       WHERE t.id = ?`,
      [target.threadId],
    );
    await q.exec(
      `UPDATE forums f JOIN threads t ON t.forum_id = f.id
       SET f.thread_count = f.thread_count + 1, f.post_count = f.post_count + 1,
           f.last_post_id = t.last_post_id, f.last_posted_at = t.last_posted_at
       WHERE t.id = ?`,
      [target.threadId],
    );
    await q.exec(
      `UPDATE user_stats s JOIN posts p ON p.author_id = s.user_id
       SET s.thread_count = s.thread_count + 1, s.post_count = s.post_count + 1,
           s.last_post_at = p.created_at WHERE p.id = ?`,
      [target.postId],
    );
  }
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

type RowScope = { where: string; params: (number | string)[] };

/** 空夹具不产生扫描或删除条件；列名和表达式只由下方固定的 SQL 片段提供。 */
function inScope(column: string, values: readonly (number | string)[]): RowScope {
  return values.length
    ? { where: `${column} IN (${values.map(() => "?").join(",")})`, params: [...values] }
    : { where: "0", params: [] };
}

function orScope(...scopes: RowScope[]): RowScope {
  return {
    where: scopes.map(({ where }) => `(${where})`).join(" OR "),
    params: scopes.flatMap(({ params }) => params),
  };
}

/** 按本次验收的主键或唯一标记回收数据；共用管理员只能用于定位对应的令牌审计。 */
export async function cleanupManageArtifacts(input: {
  tokenNames: readonly string[];
  adminUserIds: readonly number[];
  authorUserIds: readonly number[];
  targets: readonly PendingThread[];
  temporaryAdminUserIds?: readonly number[];
  forumNames?: readonly string[];
}): Promise<void> {
  await withE2eDb(async (q) => {
    const ownedUsers = [
      ...new Set([...input.authorUserIds, ...(input.temporaryAdminUserIds ?? [])]),
    ].filter((id) => id > 0);
    const actors = [...input.adminUserIds, ...(input.temporaryAdminUserIds ?? [])];
    const postIds = input.targets.map(({ postId }) => postId).filter(Boolean);
    const threadIds = input.targets.map(({ threadId }) => threadId).filter(Boolean);
    const target = (kind: string, ids: readonly (string | number)[]): RowScope => {
      const scope = inScope("target_id", ids);
      return { ...scope, where: `target_type = '${kind}' AND ${scope.where}` };
    };
    const find = <T>(table: string, columns: string, scope: RowScope) =>
      scope.params.length
        ? q.query<T>(`SELECT ${columns} FROM ${table} WHERE ${scope.where}`, scope.params)
        : Promise.resolve([] as T[]);

    const tokenScope = inScope("name", input.tokenNames);
    const forumScope = inScope("name", input.forumNames ?? []);
    const reports = inScope("post_id", postIds);
    const announcements = inScope("created_by", ownedUsers);
    const tokens = await find<{ id: string; suffix: string }>(
      "admin_api_tokens",
      "id, suffix",
      tokenScope,
    );
    const forumIds = (await find<{ id: number }>("forums", "id", forumScope)).map(({ id }) => id);
    const reportIds = (await find<{ id: number }>("reports", "id", reports)).map(({ id }) => id);
    const announcementIds = (await find<{ id: number }>("announcements", "id", announcements)).map(
      ({ id }) => id,
    );
    const userScope = inScope("user_id", ownedUsers);
    const actorScope = inScope("actor_id", ownedUsers);
    // 覆盖补发的主题创建事件，以及只按用户归属的积分变更等二级事件。
    const eventScope = orScope(
      actorScope,
      inScope("JSON_UNQUOTE(JSON_EXTRACT(payload, '$.postId'))", postIds.map(String)),
      inScope("JSON_UNQUOTE(JSON_EXTRACT(payload, '$.threadId'))", threadIds.map(String)),
      inScope("JSON_UNQUOTE(JSON_EXTRACT(payload, '$.userId'))", ownedUsers.map(String)),
      inScope("JSON_UNQUOTE(JSON_EXTRACT(payload, '$.forumId'))", forumIds.map(String)),
    );
    const outboxIds = (await find<{ id: number }>("event_outbox", "id", eventScope)).map(
      ({ id }) => id,
    );
    // 在出箱删除前保留凭证键；退出检查不能依赖已删出箱的 JOIN，否则孤儿会被漏掉。
    const outboxScope = inScope("outbox_id", outboxIds);
    const tokenIds = tokens.map(({ id }) => id);
    const tokenSuffix = inScope(
      "BINARY JSON_UNQUOTE(JSON_EXTRACT(after_json, '$.tokenSuffix'))",
      tokens.map(({ suffix }) => suffix),
    );
    const tokenAudit = orScope(target("admin_api_token", tokenIds), {
      ...tokenSuffix,
      where: `target_type = 'manage_api' AND ${tokenSuffix.where}`,
    });
    const tokenActor = inScope("actor_id", actors);
    const scopedTokenAudit =
      tokens.length && actors.length
        ? {
            where: `${tokenActor.where} AND (${tokenAudit.where})`,
            params: [...tokenActor.params, ...tokenAudit.params],
          }
        : tokenAudit;
    const audits = orScope(
      scopedTokenAudit,
      actorScope,
      target("post", postIds.map(String)),
      target("thread", threadIds.map(String)),
      target("report", reportIds.map(String)),
      target("forum", forumIds.map(String)),
    );

    const rows: [string, RowScope][] = [
      ["notification_receipts", orScope(outboxScope, userScope)],
      ["notification_deliveries", outboxScope],
      [
        "notifications",
        orScope(
          userScope,
          actorScope,
          target("post", postIds),
          target("thread", threadIds),
          target("report", reportIds),
          target("forum", forumIds),
        ),
      ],
      ["email_log", userScope],
      ["push_log", userScope],
      ["event_outbox", eventScope],
      ["event_log", eventScope],
      ["manage_api_idempotency", inScope("token_id", tokenIds)],
      ["audit_log", audits],
      ["admin_api_tokens", tokenScope],
      ["reports", reports],
      ["content_reviews", inScope("post_id", postIds)],
      ["user_appeals", userScope],
      ["user_restrictions", userScope],
      ["point_ledger", userScope],
      ["point_accounts", userScope],
      ["announcement_reads", orScope(userScope, inScope("announcement_id", announcementIds))],
      ["announcements", announcements],
      ["invite_codes", inScope("created_by", ownedUsers)],
      ["sessions", userScope],
      ["notification_preferences", userScope],
      ["user_badges", userScope],
      ["user_stats", userScope],
      ["user_roles", userScope],
      ["posts", orScope(inScope("id", postIds), inScope("thread_id", threadIds))],
      ["threads", inScope("id", threadIds)],
      ["forums", forumScope],
      ["users", inScope("id", ownedUsers)],
    ];
    await q.exec("START TRANSACTION");
    try {
      for (const [table, scope] of rows) {
        if (scope.params.length)
          await q.exec(`DELETE FROM ${table} WHERE ${scope.where}`, scope.params);
      }
      await q.exec("COMMIT");
    } catch (error) {
      await q.exec("ROLLBACK");
      throw error;
    }

    const checks: [string, RowScope][] = [
      ...rows,
      ["threads", inScope("forum_id", forumIds)],
      ["forums", inScope("last_post_id", postIds)],
      // 再按业务键核对奖励没有指向已删除的内容；不改动共用账号的账户。
      [
        "point_ledger",
        inScope("idempotency_key", [
          ...threadIds.map((id) => `thread:${id}`),
          ...postIds.map((id) => `reply:${id}`),
        ]),
      ],
    ];
    for (const [table, scope] of checks) {
      const found = await find<{ n: number }>(table, "COUNT(*) AS n", scope);
      if (found.length) expect(Number(found[0].n), `${table} 不得残留本次管理验收的数据`).toBe(0);
    }
  });
}

/** 一次性运行编号，用于区分本次验收产生的行。 */
export function runTag(): string {
  return randomUUID().slice(0, 8);
}
