import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { USERS, loginAs } from "./support/session";
import {
  bearer,
  cleanupManageArtifacts,
  expectManageError,
  fillEndpointPath,
  issueManageToken,
  runTag,
  WRITE_ENDPOINTS,
} from "./support/manage-api";

/**
 * 管理 REST 停写门禁（独立一轮验收）。
 *
 * 只有在写入口关闭（`MANAGE_API_WRITES` 未设为 on）的环境下运行：全部写端点应返回 503
 * `writes_disabled`，读端点仍可用。CI 的常规 E2E 开启写入，因此本文件在那里跳过，
 * 由 `pnpm test:e2e:write-gate` 单独跑一轮停写验收。
 *
 * 写端点清单取自对外契约（REST_ENDPOINTS 派生），新增写端点自动纳入门禁断言。
 */

/** 仅停写轮显式传 E2E_MANAGE_API_WRITES=off（webServer 据此设 MANAGE_API_WRITES=off）；其余轮次一律跳过。 */
const WRITE_GATE_ROUND = process.env.E2E_MANAGE_API_WRITES === "off";
const TAG = runTag();
const NAME_PREFIX = `E2E 停写门禁 · ${TAG} · `;

test.describe("管理 REST 停写门禁", () => {
  test.skip(!WRITE_GATE_ROUND, "本规格仅在停写轮（E2E_MANAGE_API_WRITES=off）运行");

  const tokenNames: string[] = [];

  test.afterAll(async () => {
    await cleanupManageArtifacts({
      tokenNames,
      adminUserIds: [USERS.admin],
      authorUserIds: [],
      targets: [],
    });
  });

  test(`全部 ${WRITE_ENDPOINTS.length} 个写端点返回 503，读端点与未鉴权响应不变`, async ({
    context,
    page,
    request,
  }) => {
    await loginAs(context, USERS.admin);
    const name = `${NAME_PREFIX}写令牌`;
    tokenNames.push(name);
    // 各写域的 write 权限让令牌通过写端点的授权层，确保 503 确实来自停写门禁而非权限拒绝。
    const token = await issueManageToken(page, name, {
      contents: "write",
      reports: "write",
      users: "write",
      identity: "read",
    });

    // 门禁先于参数解析触发：统一探测目标即可，无需按端点构造合法请求体。
    for (const endpoint of WRITE_ENDPOINTS) {
      const response = await request.fetch(fillEndpointPath(endpoint.path), {
        method: endpoint.method,
        headers: {
          ...bearer(token),
          "Idempotency-Key": randomUUID(),
          "content-type": "application/json",
        },
        data: {},
      });
      await expectManageError(response, 503, "writes_disabled");
    }

    // 读端点不受停写影响。
    expect((await request.get("/api/manage/whoami", { headers: bearer(token) })).status()).toBe(
      200,
    );
    expect((await request.get("/api/manage/contents", { headers: bearer(token) })).status()).toBe(
      200,
    );

    // 未鉴权仍是 401，不因停写改成 503。
    await expectManageError(await request.get("/api/manage/whoami"), 401, "unauthorized");
  });
});
