// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getWebDb, notificationPreferences, userProfiles } from "@funwind/db";
import { rateLimit, resetRateLimiter } from "@/lib/auth/ratelimit";
import { getCurrentUser } from "@/lib/auth/session";
import { isKnownPackId } from "@/lib/theme/catalog";
import { PATCH } from "./route";

const writes = vi.hoisted(() => ({
  insert: vi.fn(),
  values: vi.fn(),
  upsert: vi.fn(),
  update: vi.fn(),
  set: vi.fn(),
  where: vi.fn(),
}));
vi.mock("@funwind/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@funwind/db")>()),
  getWebDb: vi.fn(() => ({ insert: writes.insert, update: writes.update })),
}));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/theme/catalog", () => ({ isKnownPackId: vi.fn() }));

const url = "http://localhost:3100/api/settings/preferences";
const patch = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(url, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const asUser = (id = 42) =>
  vi.mocked(getCurrentUser).mockResolvedValue({
    id,
    username: `u${id}`,
    email: null,
    emailVerified: false,
    passwordHashIsSet: false,
  });
const noWrites = () => {
  expect(getWebDb).not.toHaveBeenCalled();
  expect(writes.insert).not.toHaveBeenCalled();
  expect(writes.update).not.toHaveBeenCalled();
};
const exhaustQuota = (id = 42) => {
  for (let i = 0; i < 60; i++) rateLimit(`settings-preferences:user:${id}`, 60, 60_000);
};

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimiter();
  vi.mocked(getCurrentUser).mockResolvedValue(null);
  vi.mocked(isKnownPackId).mockImplementation(async (pack) => ["default", "qy2010"].includes(pack));
  writes.insert.mockReturnValue({ values: writes.values });
  writes.values.mockReturnValue({ onDuplicateKeyUpdate: writes.upsert });
  writes.upsert.mockResolvedValue(undefined);
  writes.update.mockReturnValue({ set: writes.set });
  writes.set.mockReturnValue({ where: writes.where });
  writes.where.mockResolvedValue(undefined);
});

describe("PATCH /api/settings/preferences", () => {
  it("未登录返回原 401，读取请求体前拒绝，不消耗额度或写库", async () => {
    const request = patch("非法 JSON");
    const json = vi.spyOn(request, "json");
    const response = await PATCH(request);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(json).not.toHaveBeenCalled();
    expect(rateLimit("settings-preferences:user:42", 60, 60_000).remaining).toBe(59);
    noWrites();
  });

  it("跨站先于鉴权与读取请求体拒绝，保留原 403", async () => {
    asUser();
    const request = patch("非法 JSON", { origin: "https://evil.example" });
    const json = vi.spyOn(request, "json");
    const response = await PATCH(request);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(getCurrentUser).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
    noWrites();
  });

  it.each([
    "非法 JSON",
    null,
    {},
    { kind: "theme", theme: "dark" },
    { kind: "themePack", pack: 1 },
    { kind: "themePack", pack: "x".repeat(33) },
    { kind: "pmPolicy", pmPolicy: "unknown" },
    { kind: "notif", type: "reply", enabled: true },
    { kind: "notif", type: "", channel: "in_app", enabled: true },
    { kind: "notif", type: "reply", channel: "email", enabled: "on" },
  ])("非法 JSON / schema 返回原 400，且不消耗额度：%j", async (body) => {
    asUser();
    const response = await PATCH(patch(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_request" });
    expect(rateLimit("settings-preferences:user:42", 60, 60_000).remaining).toBe(59);
    noWrites();
  });

  it.each(["in_app", "email"] as const)("通知 %s 仍单语句 upsert，并保留响应", async (channel) => {
    asUser();
    const response = await PATCH(patch({ kind: "notif", type: "reply", channel, enabled: false }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, type: "reply", channel, enabled: false });
    expect(writes.insert).toHaveBeenCalledExactlyOnceWith(notificationPreferences);
    expect(writes.values).toHaveBeenCalledExactlyOnceWith({
      userId: 42,
      type: "reply",
      channel,
      enabled: false,
    });
    expect(writes.upsert).toHaveBeenCalledExactlyOnceWith({ set: { enabled: false } });
    expect(writes.update).not.toHaveBeenCalled();
    expect(isKnownPackId).not.toHaveBeenCalled();
  });

  it.each(["all", "following", "off"] as const)(
    "PM %s 复用单语句 update，不补建 profile",
    async (pmPolicy) => {
      asUser();
      const response = await PATCH(patch({ kind: "pmPolicy", pmPolicy }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, pmPolicy });
      expect(writes.update).toHaveBeenCalledExactlyOnceWith(userProfiles);
      expect(writes.set).toHaveBeenCalledExactlyOnceWith({ pmPolicy });
      expect(writes.where).toHaveBeenCalledOnce();
      expect(writes.insert).not.toHaveBeenCalled();
      expect(isKnownPackId).not.toHaveBeenCalled();
    },
  );

  it.each(["default", "qy2010", null])("主题 %s 经共享服务写入，目录只校验一次", async (pack) => {
    asUser();
    const response = await PATCH(
      patch(
        { kind: "themePack", pack },
        { host: "127.0.0.1:3100", origin: "http://127.0.0.1:3100" },
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, pack });
    expect(writes.insert).toHaveBeenCalledExactlyOnceWith(userProfiles);
    expect(writes.values).toHaveBeenCalledExactlyOnceWith({ userId: 42, themePack: pack });
    expect(writes.upsert).toHaveBeenCalledExactlyOnceWith({ set: { themePack: pack } });
    expect(writes.update).not.toHaveBeenCalled();
    if (pack === null) expect(isKnownPackId).not.toHaveBeenCalled();
    else expect(isKnownPackId).toHaveBeenCalledExactlyOnceWith(pack);
  });

  it.each(["retired-pack", "disabled-pack", "", "site"])(
    "目录拒绝未知或停用的包 %s：400 且不写库",
    async (pack) => {
      asUser();
      const response = await PATCH(patch({ kind: "themePack", pack }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "bad_request" });
      expect(isKnownPackId).toHaveBeenCalledExactlyOnceWith(pack);
      noWrites();
    },
  );

  it.each([
    { kind: "notif", type: "reply", channel: "in_app", enabled: false },
    { kind: "pmPolicy", pmPolicy: "off" },
    { kind: "themePack", pack: "qy2010" },
  ])("配额耗尽：三种偏好均 429 + Retry-After，服务不读目录也不落库：%j", async (body) => {
    asUser();
    exhaustQuota();
    const response = await PATCH(patch(body));
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "rate_limited" });
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(Number(response.headers.get("Retry-After"))).toBeLessThanOrEqual(60);
    expect(isKnownPackId).not.toHaveBeenCalled();
    noWrites();
  });

  it("三种偏好交替共用 60 次额度，第 61 次无写入，其他用户不受影响", async () => {
    asUser();
    const bodies = [
      { kind: "notif", type: "reply", channel: "email", enabled: true },
      { kind: "pmPolicy", pmPolicy: "following" },
      { kind: "themePack", pack: "qy2010" },
    ];
    for (let i = 0; i < 60; i++) expect((await PATCH(patch(bodies[i % 3]))).status).toBe(200);
    vi.clearAllMocks();
    expect((await PATCH(patch(bodies[0]))).status).toBe(429);
    noWrites();
    asUser(43);
    expect((await PATCH(patch(bodies[0]))).status).toBe(200);
    expect(writes.values).toHaveBeenCalledExactlyOnceWith({
      userId: 43,
      type: "reply",
      channel: "email",
      enabled: true,
    });
  });

  it("写入错误继续抛出，不误报 200 或 bad_request，也不执行其他偏好写入", async () => {
    asUser();
    const failure = new Error("模拟写入失败");
    writes.upsert.mockRejectedValueOnce(failure);
    await expect(PATCH(patch({ kind: "themePack", pack: "qy2010" }))).rejects.toBe(failure);
    expect(writes.update).not.toHaveBeenCalled();
    expect(isKnownPackId).toHaveBeenCalledExactlyOnceWith("qy2010");
  });
});
