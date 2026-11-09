// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyOpsReload, opsServiceConfig, opsServiceHealth, triggerOpsTask } from "./client";

const ENV_KEYS = [
  "OPS_SERVICE_URL",
  "OPS_API_TOKEN",
  "BACKUP_SERVICE_URL",
  "BACKUP_OPS_TOKEN",
] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function configure(env: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
}

function respond(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  configure({ OPS_SERVICE_URL: "http://funwind-ops:8000/", OPS_API_TOKEN: "t0ken" });
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.unstubAllGlobals();
});

describe("opsServiceConfig：新名优先、旧名兜底一轮（M14 D10）", () => {
  it("新名齐全：去掉末尾斜杠", () => {
    expect(opsServiceConfig()).toEqual({ baseUrl: "http://funwind-ops:8000", token: "t0ken" });
  });
  it("只有旧名：照样可用（回滚到旧镜像 / 尚未改 .env）", () => {
    configure({ BACKUP_SERVICE_URL: "http://funwind-backup:8000", BACKUP_OPS_TOKEN: "old" });
    expect(opsServiceConfig()).toEqual({ baseUrl: "http://funwind-backup:8000", token: "old" });
  });
  it("新旧混配：逐项新名优先", () => {
    configure({
      OPS_SERVICE_URL: "http://new:8000",
      BACKUP_SERVICE_URL: "http://old:8000",
      BACKUP_OPS_TOKEN: "old",
    });
    expect(opsServiceConfig()).toEqual({ baseUrl: "http://new:8000", token: "old" });
  });
  it("缺任一项：未部署（null）", () => {
    configure({ OPS_SERVICE_URL: "http://new:8000" });
    expect(opsServiceConfig()).toBeNull();
  });
});

describe("triggerOpsTask：异步手动触发", () => {
  it("202 → 拿到运行编号；请求带口令头、任务键做 URL 编码", async () => {
    const fetchMock = respond(202, { ok: true, run_id: 42 });
    vi.stubGlobal("fetch", fetchMock);
    expect(await triggerOpsTask("backup.db")).toEqual({ ok: true, runId: 42 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://funwind-ops:8000/tasks/backup.db/runs");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "x-ops-token": "t0ken" });
    await triggerOpsTask("a/b c");
    expect((fetchMock.mock.calls[1] as unknown as [string])[0]).toBe(
      "http://funwind-ops:8000/tasks/a%2Fb%20c/runs",
    );
  });

  it("202 但编号不可识别 → failed（不把垃圾当成功）", async () => {
    vi.stubGlobal("fetch", respond(202, { run_id: "x" }));
    expect(await triggerOpsTask("backup.db")).toMatchObject({ ok: false, code: "failed" });
  });

  it.each([
    [409, "busy", "同组已有任务在执行，稍后再试"],
    [404, "not-found", "任务不存在：nope"],
    [400, "rejected", "任务 nope 已停用或未配置手动触发器"],
    [503, "unavailable", "服务降级：缺少必需环境变量 OPS_TOKEN"],
  ])("%i → %s，透传管线说明", async (status, code, detail) => {
    vi.stubGlobal("fetch", respond(status, { detail }));
    expect(await triggerOpsTask("nope")).toEqual({ ok: false, code, message: detail });
  });

  it("401 → 指出口令不一致；其他状态码带上状态与说明", async () => {
    vi.stubGlobal("fetch", respond(401, { detail: "X-OPS-Token 无效" }));
    const unauthorized = await triggerOpsTask("backup.db");
    expect(unauthorized).toMatchObject({ ok: false, code: "unauthorized" });
    expect(!unauthorized.ok && unauthorized.message).toContain("OPS_API_TOKEN");
    vi.stubGlobal("fetch", respond(500, { detail: "boom" }));
    expect(await triggerOpsTask("backup.db")).toEqual({
      ok: false,
      code: "failed",
      message: "管线返回 500：boom",
    });
  });

  it("网络失败 → failed 且不抛；未配置 → unconfigured 且不发请求", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("ECONNREFUSED"))),
    );
    const down = await triggerOpsTask("backup.db");
    expect(down).toMatchObject({ ok: false, code: "failed" });
    expect(!down.ok && down.message).toContain("ECONNREFUSED");

    configure({});
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await triggerOpsTask("backup.db")).toMatchObject({ ok: false, code: "unconfigured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("notifyOpsReload：best-effort，永不抛错", () => {
  it("管线确认 → true；打到 /config/reload 并带口令", async () => {
    const fetchMock = respond(200, { ok: true });
    vi.stubGlobal("fetch", fetchMock);
    expect(await notifyOpsReload()).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://funwind-ops:8000/config/reload");
    expect(init.headers).toEqual({ "x-ops-token": "t0ken" });
  });
  it("降级（503）/ 网络失败 / 未配置 → false", async () => {
    vi.stubGlobal("fetch", respond(503, { detail: "x" }));
    expect(await notifyOpsReload()).toBe(false);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("timeout"))),
    );
    expect(await notifyOpsReload()).toBe(false);
    configure({});
    expect(await notifyOpsReload()).toBe(false);
  });
});

describe("opsServiceHealth", () => {
  it("健康 / 降级 503（正文结构不变）/ 网络失败 / 未配置", async () => {
    vi.stubGlobal("fetch", respond(200, { ok: true, scheduler_jobs: ["t1", "t3"] }));
    expect(await opsServiceHealth()).toEqual({ ok: true, jobs: ["t1", "t3"] });
    vi.stubGlobal("fetch", respond(503, { ok: false, scheduler_jobs: [] }));
    expect(await opsServiceHealth()).toEqual({ ok: false, jobs: [] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("down"))),
    );
    expect(await opsServiceHealth()).toEqual({ ok: false, jobs: [] });
    configure({});
    expect(await opsServiceHealth()).toBeNull();
  });
});
