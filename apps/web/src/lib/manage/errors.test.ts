import { describe, expect, it } from "vitest";
import { MANAGE_ERROR_CODES, ManageApiError, manageErrorBody, manageOkBody } from "./errors";

describe("管理 API 信封与错误码注册表（M20 G-15）", () => {
  it("读写错误码、状态码与文案成对", () => {
    expect(
      Object.fromEntries(
        Object.entries(MANAGE_ERROR_CODES).map(([code, def]) => [code, def.status]),
      ),
    ).toEqual({
      bad_request: 400,
      unauthorized: 401,
      forbidden: 403,
      not_found: 404,
      state_conflict: 409,
      idempotency_conflict: 409,
      payload_too_large: 413,
      unsupported_media_type: 415,
      rate_limited: 429,
      internal: 500,
      ops_unavailable: 503,
      writes_disabled: 503,
    });
    expect(MANAGE_ERROR_CODES.unauthorized.status).toBe(401);
    expect(MANAGE_ERROR_CODES.forbidden.status).toBe(403);
    expect(MANAGE_ERROR_CODES.not_found.status).toBe(404);
    expect(MANAGE_ERROR_CODES.bad_request.status).toBe(400);
    expect(MANAGE_ERROR_CODES.rate_limited.status).toBe(429);
    expect(MANAGE_ERROR_CODES.internal.status).toBe(500);
    for (const def of Object.values(MANAGE_ERROR_CODES)) {
      expect(def.message.length).toBeGreaterThan(0);
    }
  });

  it("manageOkBody：{ ok:true, data } 形状", () => {
    expect(manageOkBody({ items: [] })).toEqual({ ok: true, data: { items: [] } });
  });

  it("manageErrorBody：码经注册表查文案（对外口径单一）", () => {
    const body = manageErrorBody("unauthorized");
    expect(body.error.code).toBe("unauthorized");
    expect(body.error.message).toBe(MANAGE_ERROR_CODES.unauthorized.message);
  });

  it("ManageApiError：携带码与 Retry-After，message 即注册表文案", () => {
    const e = new ManageApiError("rate_limited", 42);
    expect(e.code).toBe("rate_limited");
    expect(e.retryAfterSec).toBe(42);
    expect(e.message).toBe(MANAGE_ERROR_CODES.rate_limited.message);
    expect(new ManageApiError("forbidden").retryAfterSec).toBeUndefined();
  });
});
