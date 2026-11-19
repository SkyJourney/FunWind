import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { USERS, loginAs } from "./support/session";
import {
  bearer,
  cleanupManageArtifacts,
  expectManageError,
  issueManageToken,
  runTag,
} from "./support/manage-api";

/**
 * 管理 REST 停写门禁（独立一轮验收）。
 *
 * 只有在写入口关闭（`MANAGE_API_WRITES` 未设为 on）的环境下运行：写端点应返回 503
 * `writes_disabled`，读端点仍可用。CI 的常规 E2E 开启写入，因此本文件在那里跳过，
 * 由 `pnpm test:e2e:write-gate` 单独跑一轮停写验收。
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

  test("写端点返回 503，读端点与未鉴权响应不变", async ({ context, page, request }) => {
    await loginAs(context, USERS.admin);
    const name = `${NAME_PREFIX}写令牌`;
    tokenNames.push(name);
    const token = await issueManageToken(page, name, { contents: "write", identity: "read" });

    const review = await request.post("/api/manage/posts/1/review", {
      headers: { ...bearer(token), "Idempotency-Key": randomUUID() },
      data: { decision: "approve", expectedEditedAt: null },
    });
    await expectManageError(review, 503, "writes_disabled");

    const lock = await request.put("/api/manage/threads/1/lock", {
      headers: { ...bearer(token), "Idempotency-Key": randomUUID() },
      data: { locked: true },
    });
    await expectManageError(lock, 503, "writes_disabled");

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
