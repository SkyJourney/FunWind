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
