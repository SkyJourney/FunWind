// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveThemePackAction } from "@/app/admin/themes/actions";
import type { ActionDef } from "@/lib/actions/define-action";

const dependencies = vi.hoisted(() => ({
  update: vi.fn(),
  redirect: vi.fn(),
  revalidate: vi.fn(),
}));
vi.mock("@/lib/actions/define-action", () => ({
  defineAction:
    <I>(definition: ActionDef<I>) =>
    async (data: FormData) => {
      const parsed = definition.input!.safeParse(Object.fromEntries(data));
      if (!parsed.success) throw new Error("invalid-input");
      return definition.run({ actor: { userId: 7 } } as never, parsed.data, data);
    },
}));
vi.mock("next/cache", () => ({ revalidatePath: dependencies.revalidate }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    dependencies.redirect(url);
    throw new Error(url);
  },
}));
vi.mock("@/lib/theme/packs", () => ({
  updateThemePack: dependencies.update,
  getThemePackDecorRefs: () => [],
}));
vi.mock("@/lib/theme/apply-pack-logo", () => ({ tryApplyThemePackLogo: vi.fn() }));
vi.mock("@/lib/brand/decor-pool", () => ({ getDecorPoolRaw: vi.fn() }));
vi.mock("@/lib/chrome/site-chrome", () => ({ invalidateSiteChrome: vi.fn() }));
const ID = "12345678-1234-4234-8234-123456789abc";
function data(id?: string) {
  const form = new FormData();
  for (const [key, value] of Object.entries({
    id: "test",
    revision: "4",
    name: "主题",
    description: "说明",
    definition: '{"surfaces":{}}',
  }))
    form.set(key, value);
  if (id !== undefined) form.set("submissionId", id);
  return form;
}
beforeEach(() => {
  vi.clearAllMocks();
  dependencies.update.mockResolvedValue({ ok: true });
});

describe("主题保存成功回执", () => {
  it("仅事务成功才原样回传本次非敏感随机标识", async () => {
    await expect(saveThemePackAction(data(ID))).rejects.toThrow(
      `/admin/themes/test?saved=1&ack=${ID}`,
    );
    expect(dependencies.redirect).toHaveBeenCalledWith(`/admin/themes/test?saved=1&ack=${ID}`);
    expect(dependencies.update).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 4 }),
    );
    expect(dependencies.update.mock.calls[0][0]).not.toHaveProperty("submissionId");
  });
  it.each([undefined, ""])("旧的无 submission 调用仍返回原 saved=1 URL：%s", async (id) => {
    await expect(saveThemePackAction(data(id))).rejects.toThrow("/admin/themes/test?saved=1");
    expect(dependencies.redirect).toHaveBeenCalledExactlyOnceWith("/admin/themes/test?saved=1");
  });
  it("冲突不返回成功 ack", async () => {
    dependencies.update.mockResolvedValue({ ok: false, code: "conflict" });
    await expect(saveThemePackAction(data(ID))).rejects.toThrow("/admin/themes/test?err=conflict");
    expect(dependencies.redirect).toHaveBeenCalledExactlyOnceWith(
      "/admin/themes/test?err=conflict",
    );
  });
  it("非 UUID 输入不能拼接成功 URL", async () => {
    await expect(saveThemePackAction(data("invalid&saved=1"))).rejects.toThrow("invalid-input");
    expect(dependencies.update).not.toHaveBeenCalled();
    expect(dependencies.redirect).not.toHaveBeenCalled();
  });
});

describe("校验被拒时把具体问题带回编辑页（Step 3e）", () => {
  const redirected = () => dependencies.redirect.mock.calls.map((call) => String(call[0]));
  const issuesIn = (url: string) => new URL(url, "http://x").searchParams.getAll("issue");

  it("invalid-definition：错误码后面跟着每条问题，顺序不变，逐条编码", async () => {
    dependencies.update.mockResolvedValue({
      ok: false,
      code: "invalid-definition",
      errors: ["surfaces.header.light.blur: Too big", "pwa.themeColor: 非法颜色（须 #RRGGBB）"],
    });
    await expect(saveThemePackAction(data(ID))).rejects.toThrow();
    expect(redirected()).toEqual([
      "/admin/themes/test?err=invalid-definition" +
        `&issue=${encodeURIComponent("surfaces.header.light.blur: Too big")}` +
        `&issue=${encodeURIComponent("pwa.themeColor: 非法颜色（须 #RRGGBB）")}`,
    ]);
  });

  it("最多带 6 条；每条最长 120 字符", async () => {
    dependencies.update.mockResolvedValue({
      ok: false,
      code: "invalid-definition",
      errors: [...Array.from({ length: 9 }, (_, i) => `p${i}: 错`), "字".repeat(500)],
    });
    await expect(saveThemePackAction(data(ID))).rejects.toThrow();
    const issues = issuesIn(redirected()[0]);
    expect(issues).toEqual(["p0: 错", "p1: 错", "p2: 错", "p3: 错", "p4: 错", "p5: 错"]);
    dependencies.redirect.mockClear();
    dependencies.update.mockResolvedValue({
      ok: false,
      code: "invalid-definition",
      errors: ["字".repeat(500)],
    });
    await expect(saveThemePackAction(data(ID))).rejects.toThrow();
    expect([...issuesIn(redirected()[0])[0]]).toHaveLength(120);
  });

  it("没有 errors：只有错误码，不带 issue", async () => {
    dependencies.update.mockResolvedValue({ ok: false, code: "invalid-definition" });
    await expect(saveThemePackAction(data(ID))).rejects.toThrow();
    expect(redirected()).toEqual(["/admin/themes/test?err=invalid-definition"]);
  });

  it.each(["conflict", "bad-name", "not-found", "capacity-unavailable"])(
    "%s 即使带了 errors 也不带 issue（只有校验未通过才有可列的细节）",
    async (code) => {
      dependencies.update.mockResolvedValue({ ok: false, code, errors: ["pwa.themeColor: 错"] });
      await expect(saveThemePackAction(data(ID))).rejects.toThrow();
      expect(redirected()).toEqual([`/admin/themes/test?err=${code}`]);
    },
  );

  it("校验未通过时不写 saved，也不返回 ack", async () => {
    dependencies.update.mockResolvedValue({
      ok: false,
      code: "invalid-definition",
      errors: ["a: 错"],
    });
    await expect(saveThemePackAction(data(ID))).rejects.toThrow();
    expect(redirected()[0]).not.toMatch(/saved=|ack=/);
    expect(dependencies.revalidate).not.toHaveBeenCalled();
  });
});
