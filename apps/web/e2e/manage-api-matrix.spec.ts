import { expect, test, type Page } from "@playwright/test";
import { loginAs } from "./support/session";
import { withE2eDb } from "./support/db";
import {
  MISSING_ID,
  WRITE_ENDPOINTS,
  bearer,
  cleanupManageArtifacts,
  createAdminUser,
  fillEndpointPath,
  insertLegacyToken,
  issueManageToken,
  runTag,
  type ManageDomain,
  type ManageLevel,
} from "./support/manage-api";

/**
 * 管理 REST 权限矩阵 × 全端点验收（M20.2 立式，M20.3 扩容）。
 *
 * 系统化覆盖「权限档位 × 数据域 × 端点」：十二种令牌档位（各单域只读、内容写档、举报写档、
 * 全域只读、历史九读）逐一调用全部端点并断言状态；每个查询端点另附对隔离夹具数据的
 * 形状与内容断言，以及参数错误路径（400）与未登记方法（405/404）。
 *
 * 期望规则（与 docs/MANAGE-API.md 对外契约独立成文，不从实现生成）：
 *  - 读端点：令牌授予该域（读或写）→ 200；未授予 → 403。
 *  - 写端点（本轮写入口开启）：授予对应写档 → 通过写权门，目标不存在故 404；否则 403。
 *  - 历史令牌：九个 GET 全 200，写端点 403。
 *  - 凭证吊销/过期后一切端点 401（见 manage-api-acceptance.spec.ts 凭证用例）。
 */

const TAG = runTag();
const NAME_PREFIX = `E2E REST 矩阵 · ${TAG} · `;

/** 夹具常量（packages/db/src/e2e-fixtures.ts 的稳定数据，隔离环境每次重建）。 */
const FIX = {
  /** 水区普通主题（forum 952，作者 alice，可见）；首帖 id 按夹具派生规则 9,000,000 + tid。 */
  threadId: 951001,
  firstPostId: 9_000_000 + 951001,
  /** 演示种子的 alice：资料完整，用于用户详情断言。 */
  userId: 90001,
  username: "demo_alice",
  /** 演示 6 人 + E2E 夹具 2 人。 */
  minUsers: 8,
  /** 矩阵夹具注入的 pending 举报 id（准备用例内落库）。 */
  reportId: 0,
  /** 13 个特殊主题 + 60 个水区主题。 */
  minThreads: 70,
} as const;

/** 端点契约（与文档对齐的独立声明）；写端点复用共享夹具的清单与示例请求体。 */
const READ_ENDPOINTS = [
  { domain: "identity", path: "/api/manage/whoami" },
  { domain: "contents", path: "/api/manage/contents" },
  { domain: "contents", path: `/api/manage/contents/${FIX.threadId}?kind=thread` },
  { domain: "users", path: "/api/manage/users?size=10" },
  { domain: "users", path: `/api/manage/users/${FIX.userId}` },
  { domain: "reports", path: "/api/manage/reports" },
  { domain: "reports", path: `/api/manage/reports/${FIX.reportId}` },
  { domain: "stats", path: "/api/manage/stats" },
  { domain: "audit-logs", path: "/api/manage/audit-logs?size=10" },
  { domain: "emails", path: "/api/manage/emails?size=10" },
  { domain: "push-logs", path: "/api/manage/push-logs?size=10" },
] as const;

/** 单域令牌的持有人与签发参数；全读与历史档另有安排。 */
type ProfileKey =
  | "identity"
  | "contents-read"
  | "contents-write"
  | "users"
  | "reports-read"
  | "reports-write"
  | "stats"
  | "audit-logs"
  | "emails"
  | "push-logs"
  | "all-read"
  | "all-read-probe"
  | "legacy";

const PROFILE_LEVELS: Record<
  Exclude<ProfileKey, "legacy">,
  Partial<Record<ManageDomain, ManageLevel>>
> = {
  identity: { identity: "read" },
  "contents-read": { contents: "read" },
  "contents-write": { contents: "write" },
  users: { users: "read" },
  "users-write": { users: "write" },
  "announcements-write": { announcements: "write" },
  "campaigns-write": { campaigns: "write" },
  "invites-write": { invites: "write" },
  "forums-write": { forums: "write" },
  "polls-write": { polls: "write" },
  "pm-write": { pm: "write" },
  "badges-write": { badges: "write" },
  "points-write": { points: "write" },
  "emojis-write": { emojis: "write" },
  "reports-read": { reports: "read" },
  "reports-write": { reports: "write" },
  stats: { stats: "read" },
  "audit-logs": { "audit-logs": "read" },
  emails: { emails: "read" },
  "push-logs": { "push-logs": "read" },
  "all-read": {
    identity: "read",
    contents: "read",
    users: "read",
    announcements: "read",
    campaigns: "read",
    invites: "read",
    forums: "read",
    polls: "read",
    badges: "read",
    points: "read",
    emojis: "read",
    stats: "read",
    "audit-logs": "read",
    emails: "read",
    "push-logs": "read",
  },
  "all-read-probe": {
    identity: "read",
    contents: "read",
    users: "read",
    announcements: "read",
    campaigns: "read",
    invites: "read",
    forums: "read",
    polls: "read",
    badges: "read",
    points: "read",
    emojis: "read",
    stats: "read",
    "audit-logs": "read",
    emails: "read",
    "push-logs": "read",
  },
};

const grantedDomains = (key: ProfileKey): readonly ManageDomain[] =>
  key === "legacy"
    ? // 历史九读不含 reports 域（M20.3 新增）
      ["identity", "contents", "users", "stats", "audit-logs", "emails", "push-logs"]
    : (Object.keys(PROFILE_LEVELS[key]) as ManageDomain[]).filter(
        (d) => PROFILE_LEVELS[key][d] !== "none",
      );

const hasWrite = (key: ProfileKey) =>
  key !== "legacy" && Object.values(PROFILE_LEVELS[key]).some((level) => level === "write");

/**
 * 签发分摊：每位管理员令牌上限 5 枚、签发频控 10 次/分钟。矩阵自建三位专用管理员，
 * 不占用演示管理员在同轮其他规格文件里的频控额度。
 */
const SECONDARY_OF: ReadonlySet<ProfileKey> = new Set([
  "audit-logs",
  "emails",
  "push-logs",
  "all-read",
  "announcements-write",
]);
const TERTIARY_OF: ReadonlySet<ProfileKey> = new Set([
  "reports-read",
  "reports-write",
  "users-write",
  "campaigns-write",
  "invites-write",
]);
/** 第四/第五专用管理员：M20.3 Step 4 六域写档位（单管理员有效令牌上限 5）。 */
const QUATERNARY_OF: ReadonlySet<ProfileKey> = new Set([
  "forums-write",
  "polls-write",
  "badges-write",
  "points-write",
  "emojis-write",
]);
const QUINARY_OF: ReadonlySet<ProfileKey> = new Set(["pm-write", "all-read-probe"]);

const tokens = new Map<ProfileKey, string>();
const tokenNames: string[] = [];
const adminUserIds: number[] = [];
let primaryAdmin = 0;
let quaternaryAdmin = 0;
let quinaryAdmin = 0;
let secondaryAdmin = 0;
let tertiaryAdmin = 0;

/** 当前测试进程内的令牌签发（真实后台表单 + 服务端二次校验）。 */
async function ensureToken(page: Page, key: Exclude<ProfileKey, "legacy">) {
  const cached = tokens.get(key);
  if (cached) return cached;
  const holder = SECONDARY_OF.has(key)
    ? secondaryAdmin
    : TERTIARY_OF.has(key)
      ? tertiaryAdmin
      : QUATERNARY_OF.has(key)
        ? quaternaryAdmin
        : QUINARY_OF.has(key)
          ? quinaryAdmin
          : primaryAdmin;
  await loginAs(page.context(), holder);
  const name = `${NAME_PREFIX}${key}`;
  const plain = await issueManageToken(page, name, PROFILE_LEVELS[key]);
  tokens.set(key, plain);
  tokenNames.push(name);
  return plain;
}

test.describe.configure({ mode: "serial" });

test.describe("管理 REST 权限矩阵 × 全端点", () => {
  test.beforeAll(async () => {
    primaryAdmin = await withE2eDb((q) => createAdminUser(q, `${TAG}-a`));
    secondaryAdmin = await withE2eDb((q) => createAdminUser(q, `${TAG}-b`));
    tertiaryAdmin = await withE2eDb((q) => createAdminUser(q, `${TAG}-c`));
    quaternaryAdmin = await withE2eDb((q) => createAdminUser(q, `${TAG}-d`));
    quinaryAdmin = await withE2eDb((q) => createAdminUser(q, `${TAG}-e`));
    adminUserIds.push(primaryAdmin, secondaryAdmin, tertiaryAdmin, quaternaryAdmin, quinaryAdmin);
  });

  test.afterAll(async () => {
    await cleanupManageArtifacts({
      tokenNames,
      adminUserIds,
      authorUserIds: [],
      targets: [],
    });
    if (FIX.reportId) {
      await withE2eDb((q) => q.exec("DELETE FROM reports WHERE id = ?", [FIX.reportId]));
    }
  });

  test.afterAll(async () => {
    // 矩阵探测的集合型创建端点留下 probe 行（真实创建），统一回收
    await withE2eDb((q) => {
      void q.exec("DELETE FROM announcements WHERE title = 'probe'");
      void q.exec("DELETE FROM campaigns WHERE name = 'probe'");
      void q.exec("DELETE FROM invite_codes WHERE batch = 'probe'");
      void q.exec("DELETE FROM emoji_groups WHERE name = 'probe'");
      void q.exec(
        "DELETE FROM audit_log WHERE target_type = 'invite_batch' AND target_id = 'probe'",
      );
    });
  });

  test("准备：签发新版令牌、注入历史令牌与 pending 举报夹具", async ({ page }) => {
    FIX.reportId = (
      await withE2eDb((q) =>
        q.exec(
          `INSERT INTO reports (post_id, reporter_id, reason, status, created_at)
           VALUES (?, ?, '矩阵夹具举报', 'pending', NOW())`,
          [FIX.firstPostId, FIX.userId],
        ),
      )
    ).insertId;
    for (const key of Object.keys(PROFILE_LEVELS) as Exclude<ProfileKey, "legacy">[]) {
      await ensureToken(page, key);
    }
    const legacy = await withE2eDb((q) =>
      insertLegacyToken(q, primaryAdmin, `${NAME_PREFIX}legacy`),
    );
    tokens.set("legacy", legacy);
    tokenNames.push(`${NAME_PREFIX}legacy`);
    expect(tokens.size).toBe(23);
  });

  /** 矩阵主体：十档位 × 十一端点的状态断言。 */
  for (const key of [
    "identity",
    "contents-read",
    "contents-write",
    "users",
    "users-write",
    "announcements-write",
    "campaigns-write",
    "invites-write",
    "forums-write",
    "polls-write",
    "pm-write",
    "badges-write",
    "points-write",
    "emojis-write",
    "stats",
    "audit-logs",
    "emails",
    "push-logs",
    "all-read",
    "legacy",
  ] as ProfileKey[]) {
    test(`矩阵 · ${key} 档位下的全部端点`, async ({ request }) => {
      const token = tokens.get(key);
      expect(token, `${key} 令牌应已签发`).toBeTruthy();
      const granted = new Set(grantedDomains(key));

      for (const endpoint of READ_ENDPOINTS) {
        const response = await request.get(endpoint.path, { headers: bearer(token!) });
        const expected = granted.has(endpoint.domain) ? 200 : 403;
        expect(
          response.status(),
          `${key} → GET ${endpoint.path}（域 ${endpoint.domain} ${granted.has(endpoint.domain) ? "已授" : "未授"}）`,
        ).toBe(expected);
        if (expected === 403) {
          expect(await response.json()).toMatchObject({ error: { code: "forbidden" } });
        }
      }

      // all-read 档的写 403 探测（40 个）与读探测（23 个）合计超单令牌频控 60/min，
      // 写探测换用同授权的探针令牌分担（认证层对 403 请求同样计数）。
      const writeToken = key === "all-read" ? tokens.get("all-read-probe")! : token!;
      for (const endpoint of WRITE_ENDPOINTS) {
        const response = await request.fetch(fillEndpointPath(endpoint.path, MISSING_ID), {
          method: endpoint.method,
          headers: {
            ...bearer(writeToken),
            "Idempotency-Key": `${TAG}-${key}`,
            "content-type": "application/json",
          },
          data: endpoint.sampleBody,
        });
        // 集合型创建端点（POST /announcements|/campaigns|/invites）无路径目标、没有 404 形态：
        // 授权通过即真实创建（probe 体，afterAll 统一清理）；其余写端点用不存在目标 → 404。
        const collects = "collects" in endpoint && endpoint.collects;
        const expected =
          granted.has(endpoint.domain) && hasWrite(key) ? (collects ? 200 : 404) : 403;
        expect(response.status(), `${key} → ${endpoint.method} ${endpoint.path}`).toBe(expected);
        if (expected !== 200) {
          expect(await response.json()).toMatchObject({
            error: { code: expected === 404 ? "not_found" : "forbidden" },
          });
        }
      }
    });
  }

  test("查询语义 · whoami 报告持有人身份、权限与令牌精确授权", async ({ request }) => {
    const identity = tokens.get("identity")!;
    const basic = await request.get("/api/manage/whoami", { headers: bearer(identity) });
    expect(basic.status()).toBe(200);
    const body = (await basic.json()) as {
      data: { user: { id: number }; permissions: string[]; tokenPermissions?: unknown };
    };
    expect(body.data.user.id).toBe(primaryAdmin);
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

    // 历史令牌的精确授权就是冻结九读。
    const legacy = await request.get("/api/manage/whoami?include=token_permissions", {
      headers: bearer(tokens.get("legacy")!),
    });
    const legacyDetail = (await legacy.json()) as {
      data: { tokenPermissions: { granted: { id: string; method: string }[] } };
    };
    expect(legacyDetail.data.tokenPermissions.granted.map((e) => e.id).sort()).toEqual([
      "audit-logs",
      "contents",
      "contents.detail",
      "emails",
      "push-logs",
      "stats",
      "users",
      "users.detail",
      "whoami",
    ]);
    expect(legacyDetail.data.tokenPermissions.granted.every((e) => e.method === "GET")).toBe(true);
  });

  test("查询语义 · 内容列表与详情断言夹具数据", async ({ request }) => {
    const token = tokens.get("contents-read")!;

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
    const token = tokens.get("users")!;

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

  test("查询语义 · 统计、审计与双日志端点的数据形状", async ({ request }) => {
    const stats = await request.get("/api/manage/stats", { headers: bearer(tokens.get("stats")!) });
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

    // 令牌签发本身写了 api_token.create 审计——用它证明审计查询返回真实行。
    const audits = await request.get("/api/manage/audit-logs?action=api_token.create&size=10", {
      headers: bearer(tokens.get("audit-logs")!),
    });
    expect(audits.status()).toBe(200);
    const audited = (await audits.json()) as {
      data: { items: { action: string }[]; total: number };
    };
    expect(audited.data.total).toBeGreaterThanOrEqual(1);
    expect(audited.data.items.every((i) => i.action === "api_token.create")).toBe(true);

    for (const [domain, path] of [
      ["emails", "/api/manage/emails?size=10"],
      ["push-logs", "/api/manage/push-logs?size=10"],
    ] as const) {
      const response = await request.get(path, { headers: bearer(tokens.get(domain)!) });
      expect(response.status()).toBe(200);
      expect(await response.json()).toMatchObject({
        data: { items: expect.any(Array), summary: expect.any(Object) },
      });
    }
  });

  test("查询语义 · 举报列表与详情断言夹具数据", async ({ request }) => {
    const token = tokens.get("reports-read")!;

    const list = await request.get("/api/manage/reports?status=pending&size=10", {
      headers: bearer(token),
    });
    expect(list.status()).toBe(200);
    const listed = (await list.json()) as {
      data: { items: { id: number; status: string }[]; total: number };
    };
    expect(listed.data.total).toBeGreaterThanOrEqual(1);
    expect(listed.data.items.some((i) => i.id === FIX.reportId)).toBe(true);

    const detail = await request.get(`/api/manage/reports/${FIX.reportId}`, {
      headers: bearer(token),
    });
    expect(detail.status()).toBe(200);
    expect(await detail.json()).toMatchObject({
      data: { id: FIX.reportId, status: "pending", reason: "矩阵夹具举报" },
    });

    // 处置状态筛选：矩阵夹具保持 pending，resolved/dismissed 筛选不含它。
    const resolved = await request.get("/api/manage/reports?status=resolved&size=10", {
      headers: bearer(token),
    });
    const resolvedList = (await resolved.json()) as { data: { items: { id: number }[] } };
    expect(resolvedList.data.items.some((i) => i.id === FIX.reportId)).toBe(false);
  });

  test("错误路径 · 非法参数与畸形路径的统一 400/404", async ({ request }) => {
    const token = tokens.get("all-read")!;
    const cases: [string, number, string][] = [
      ["/api/manage/contents?state=bogus", 400, "bad_request"],
      ["/api/manage/contents?size=999", 400, "bad_request"],
      ["/api/manage/contents?kind=bogus", 400, "bad_request"],
      ["/api/manage/contents/abc", 404, "not_found"],
      ["/api/manage/users?sort=bogus", 400, "bad_request"],
      ["/api/manage/users?status=bogus", 400, "bad_request"],
      ["/api/manage/users/abc", 404, "not_found"],
      ["/api/manage/audit-logs?from=not-a-date", 400, "bad_request"],
      ["/api/manage/emails?status=bogus", 400, "bad_request"],
      ["/api/manage/emails?kind=bogus", 400, "bad_request"],
      ["/api/manage/push-logs?scene=bogus", 400, "bad_request"],
    ];
    for (const [path, status, code] of cases) {
      const response = await request.get(path, { headers: bearer(token) });
      expect(response.status(), path).toBe(status);
      expect(await response.json(), path).toMatchObject({ error: { code } });
    }

    // 举报域的错误路径须用举报只读令牌（all-read 未授该域，会先 403）。
    const reportCases: [string, number, string][] = [
      ["/api/manage/reports?status=bogus", 400, "bad_request"],
      ["/api/manage/reports/abc", 404, "not_found"],
    ];
    const reportToken = tokens.get("reports-read")!;
    for (const [path, status, code] of reportCases) {
      const response = await request.get(path, { headers: bearer(reportToken) });
      expect(response.status(), path).toBe(status);
      expect(await response.json(), path).toMatchObject({ error: { code } });
    }
  });

  test("方法守卫 · 未登记的方法与路径不运行处理器", async ({ request }) => {
    const token = tokens.get("contents-write")!;
    // DELETE 未登记在审核端点 → 框架 405（处理器未运行、无副作用）；
    // 同文件内未登记方法转 404 的语义由 manage-api-guard 单元守卫覆盖。
    const removed = await request.delete("/api/manage/posts/1/review", {
      headers: { ...bearer(token), "Idempotency-Key": `${TAG}-delete` },
    });
    expect(removed.status()).toBe(405);
    // 未登记路径 → 框架 404（HTML 页面，非 API 信封）。
    const unknown = await request.get("/api/manage/not-a-real-endpoint", {
      headers: bearer(tokens.get("all-read")!),
    });
    expect(unknown.status()).toBe(404);
  });
});
