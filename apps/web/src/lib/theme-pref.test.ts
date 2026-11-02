import { beforeEach, describe, expect, it, vi } from "vitest";
import { getWebDb, userProfiles } from "@funwind/db";
import { isKnownPackId } from "@/lib/theme/catalog";
import { resolveEffectivePack, setUserThemePack } from "./theme-pref";

const writes = vi.hoisted(() => ({ insert: vi.fn(), values: vi.fn(), upsert: vi.fn() }));
vi.mock("@funwind/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@funwind/db")>()),
  getWebDb: vi.fn(() => ({ insert: writes.insert })),
}));
vi.mock("@/lib/theme/catalog", () => ({ isKnownPackId: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  writes.insert.mockReturnValue({ values: writes.values });
  writes.values.mockReturnValue({ onDuplicateKeyUpdate: writes.upsert });
  writes.upsert.mockResolvedValue(undefined);
  vi.mocked(isKnownPackId).mockResolvedValue(true);
});

describe("setUserThemePack（共享主题写服务）", () => {
  it("有效包只校验一次且单语句 upsert，只写主题列", async () => {
    expect(await setUserThemePack(42, "qy2010")).toBe(true);
    expect(isKnownPackId).toHaveBeenCalledExactlyOnceWith("qy2010");
    expect(writes.insert).toHaveBeenCalledExactlyOnceWith(userProfiles);
    expect(writes.values).toHaveBeenCalledExactlyOnceWith({ userId: 42, themePack: "qy2010" });
    expect(writes.upsert).toHaveBeenCalledExactlyOnceWith({ set: { themePack: "qy2010" } });
  });

  it("null 跟随站点无需读目录，仍走同一 upsert", async () => {
    expect(await setUserThemePack(42, null)).toBe(true);
    expect(isKnownPackId).not.toHaveBeenCalled();
    expect(writes.values).toHaveBeenCalledExactlyOnceWith({ userId: 42, themePack: null });
  });

  it("未知或停用包返回 false，拒绝前不获取写库句柄", async () => {
    vi.mocked(isKnownPackId).mockResolvedValue(false);
    expect(await setUserThemePack(42, "retired-pack")).toBe(false);
    expect(isKnownPackId).toHaveBeenCalledExactlyOnceWith("retired-pack");
    expect(getWebDb).not.toHaveBeenCalled();
  });

  it("目录在首次校验后变化不触发第二次重读或部分写入", async () => {
    vi.mocked(isKnownPackId).mockResolvedValueOnce(true).mockResolvedValue(false);
    expect(await setUserThemePack(42, "qy2010")).toBe(true);
    expect(isKnownPackId).toHaveBeenCalledOnce();
    expect(writes.upsert).toHaveBeenCalledOnce();
  });

  it("目录异常原样抛出，且不写库", async () => {
    const failure = new Error("模拟目录异常");
    vi.mocked(isKnownPackId).mockRejectedValueOnce(failure);
    await expect(setUserThemePack(42, "qy2010")).rejects.toBe(failure);
    expect(getWebDb).not.toHaveBeenCalled();
  });

  it("写入异常原样抛出，不伪装成无效主题", async () => {
    const failure = new Error("模拟写库异常");
    writes.upsert.mockRejectedValueOnce(failure);
    await expect(setUserThemePack(42, "qy2010")).rejects.toBe(failure);
  });
});

describe("resolveEffectivePack（生效主题包合成）", () => {
  it("用户偏好优先于站点默认", () => {
    expect(resolveEffectivePack("qy2010", "default")).toBe("qy2010");
  });

  it("用户未设（null/undefined）→ 站点默认", () => {
    expect(resolveEffectivePack(null, "qy2010")).toBe("qy2010");
    expect(resolveEffectivePack(undefined, "qy2010")).toBe("qy2010");
  });

  it("两者皆空 → default 兜底", () => {
    expect(resolveEffectivePack(null, null)).toBe("default");
    expect(resolveEffectivePack(undefined, undefined)).toBe("default");
  });
});
