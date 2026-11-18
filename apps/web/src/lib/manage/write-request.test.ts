// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { resetRateLimiter } from "@/lib/auth/ratelimit";
import { enforceManageWriteGate, MANAGE_WRITE_BODY_LIMIT, parseManageWrite } from "./write-request";

const url = "http://localhost/api/manage/threads/12/lock";
const key = "test-unique-key-12";
const schema = z.strictObject({ locked: z.boolean() });

function request(
  body: string,
  options: { media?: string; id?: string; key?: string; length?: string } = {},
) {
  const headers = new Headers({
    "content-type": options.media ?? "application/json",
    "idempotency-key": options.key ?? key,
  });
  if (options.length !== undefined) headers.set("content-length", options.length);
  return {
    request: new NextRequest(url, { method: "PUT", body, headers }),
    params: Promise.resolve({ threadId: options.id ?? "12" }),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetRateLimiter();
});

describe("管理写请求协议", () => {
  it("解析 JSON、正整数、幂等键；拒绝数组或未知字段", async () => {
    await expect(
      parseManageWrite(
        request('{"locked":true}', { media: "application/json; charset=utf-8" }),
        schema,
        "threadId",
      ),
    ).resolves.toEqual({ targetId: 12, input: { locked: true }, idempotencyKey: key });
    for (const body of ['{"locked":true,"pinLevel":3}', '[{"locked":true}]', '{"locked":"true"}']) {
      await expect(parseManageWrite(request(body), schema, "threadId")).rejects.toBeInstanceOf(
        z.ZodError,
      );
    }
  });

  it("拒绝错误媒体类型、畸形 JSON、短键与非安全资源 ID", async () => {
    const parse = (body: string, options?: Parameters<typeof request>[1]) =>
      parseManageWrite(request(body, options), schema, "threadId");
    await expect(parse("{}", { media: "text/plain" })).rejects.toMatchObject({
      code: "unsupported_media_type",
    });
    await expect(parse("{")).rejects.toMatchObject({ code: "bad_request" });
    await expect(parse("{}", { key: "short" })).rejects.toMatchObject({ code: "bad_request" });
    for (const id of ["0", "-1", "1e2", "9007199254740992"]) {
      await expect(parse("{}", { id })).rejects.toMatchObject({ code: "bad_request" });
    }
  });

  it("拒绝无长度头时实际超限的多字节请求，也拒绝伪报的较短长度", async () => {
    const body = `{"locked":true,"padding":"${"青".repeat(6000)}"}`;
    for (const ctx of [
      request(body),
      request(body, { length: "14" }),
      request("{}", { length: String(MANAGE_WRITE_BODY_LIMIT + 1) }),
    ]) {
      await expect(parseManageWrite(ctx, schema, "threadId")).rejects.toMatchObject({
        code: "payload_too_large",
      });
    }
  });

  it("默认停写；单令牌和同用户跨令牌分别限流", () => {
    const token = { id: "one", userId: 77, name: "测试", suffix: "12345678", endpointGrants: [] };
    vi.stubEnv("MANAGE_API_WRITES", "ON");
    expect(() => enforceManageWriteGate(token)).toThrow(
      expect.objectContaining({ code: "writes_disabled" }),
    );
    vi.stubEnv("MANAGE_API_WRITES", "on");
    for (const id of ["one", "two", "three"]) {
      for (let i = 0; i < 10; i++) enforceManageWriteGate({ ...token, id });
      expect(() => enforceManageWriteGate({ ...token, id })).toThrow(
        expect.objectContaining({ code: "rate_limited", retryAfterSec: expect.any(Number) }),
      );
    }
    expect(() => enforceManageWriteGate({ ...token, id: "four" })).toThrow(
      expect.objectContaining({ code: "rate_limited" }),
    );
    enforceManageWriteGate({ ...token, id: "other", userId: 78 });
  });
});
