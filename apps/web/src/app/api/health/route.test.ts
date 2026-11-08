// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getWebDb } from "@funwind/db";
import { storageWritable } from "@/lib/install/progress";
import { GET } from "./route";

vi.mock("@funwind/db", () => ({ getWebDb: vi.fn() }));
vi.mock("@/lib/install/progress", () => ({ storageWritable: vi.fn() }));

const execute = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getWebDb).mockReturnValue({ execute } as never);
  execute.mockResolvedValue([]);
  vi.mocked(storageWritable).mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("/api/health（拨测与容器 HEALTHCHECK）", () => {
  it("DB 与存储都健康：200 + ok + 不允许缓存", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ok", db: true, storage: true });
  });

  it("DB 查询失败：503 + db:false，错误细节不出响应体", async () => {
    execute.mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:3306"));
    const response = await GET();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({ status: "error", db: false, storage: true });
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
  });

  it("存储不可写：503 + storage:false（DB 仍标记健康）", async () => {
    vi.mocked(storageWritable).mockResolvedValue(false);
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "error", db: true, storage: false });
  });

  it("DB 挂起超过探针超时：3 秒内给 503 结论，不被拖死", async () => {
    vi.useFakeTimers();
    execute.mockReturnValue(new Promise<never>(() => {}));
    const pending = GET();
    await vi.advanceTimersByTimeAsync(3000);
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "error", db: false, storage: true });
  });
});
