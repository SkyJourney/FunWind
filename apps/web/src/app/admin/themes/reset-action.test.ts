// @vitest-environment node
/**
 * 重置内置主题包动作单测（M11.6 Step 3f）：表单解析（revision 必须是正整数）、
 * 服务入参、三种拒绝码的回跳、成功后的刷新与回跳顺序。权限门由 actions-actor.test.ts 覆盖，
 * 真实数据库行为由 lib/theme/pack-reset.int.test.ts 覆盖。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetThemePackAction } from "@/app/admin/themes/actions";
import type { ActionDef } from "@/lib/actions/define-action";

const dependencies = vi.hoisted(() => ({
  reset: vi.fn(),
  redirect: vi.fn(),
  revalidate: vi.fn(),
  actor: { userId: 7, via: "admin", ip: "203.0.113.7" },
}));
vi.mock("@/lib/actions/define-action", () => ({
  defineAction:
    <I>(definition: ActionDef<I>) =>
    async (data: FormData) => {
      const parsed = definition.input!.safeParse(Object.fromEntries(data));
      if (!parsed.success) throw new Error("invalid-input");
      return definition.run({ actor: dependencies.actor } as never, parsed.data, data);
    },
}));
vi.mock("next/cache", () => ({ revalidatePath: dependencies.revalidate }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    dependencies.redirect(url);
    throw new Error(url);
  },
}));
vi.mock("@/lib/theme/pack-reset", () => ({ resetThemePack: dependencies.reset }));
vi.mock("@/lib/theme/packs", () => ({}));
vi.mock("@/lib/theme/apply-pack-logo", () => ({ tryApplyThemePackLogo: vi.fn() }));
vi.mock("@/lib/brand/decor-pool", () => ({ getDecorPoolRaw: vi.fn() }));
vi.mock("@/lib/chrome/site-chrome", () => ({ invalidateSiteChrome: vi.fn() }));

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}
const redirected = () => dependencies.redirect.mock.calls.map((call) => String(call[0]));
const VALID = { id: "qy2010", revision: "4" };

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.reset.mockResolvedValue({ ok: true, value: {} });
});

describe("重置内置主题包动作（M11.6 Step 3f）", () => {
  it("成功：把列表加载时的版本与操作者交给服务，先刷新列表与编辑页，再带 saved=reset 回到列表", async () => {
    await expect(resetThemePackAction(form(VALID))).rejects.toThrow("/admin/themes?saved=reset");
    expect(dependencies.reset).toHaveBeenCalledExactlyOnceWith({
      id: "qy2010",
      expectedRevision: 4,
      actor: dependencies.actor,
    });
    expect(dependencies.revalidate.mock.calls).toEqual([
      ["/admin/themes"],
      ["/admin/themes/qy2010"],
    ]);
    expect(redirected()).toEqual(["/admin/themes?saved=reset"]);
    expect(dependencies.reset).toHaveBeenCalledBefore(dependencies.revalidate);
    expect(dependencies.revalidate).toHaveBeenCalledBefore(dependencies.redirect);
  });

  it("id 恰好 32 位仍可通过解析（与其他主题动作的上限一致）", async () => {
    const id = "a".repeat(32);
    await expect(resetThemePackAction(form({ id, revision: "4" }))).rejects.toThrow(
      "/admin/themes?saved=reset",
    );
    expect(dependencies.reset).toHaveBeenCalledWith(expect.objectContaining({ id }));
  });

  it("id 进入刷新路径前做 URL 编码", async () => {
    await expect(resetThemePackAction(form({ id: "a b/c", revision: "4" }))).rejects.toThrow();
    expect(dependencies.revalidate.mock.calls).toEqual([
      ["/admin/themes"],
      ["/admin/themes/a%20b%2Fc"],
    ]);
  });

  it.each(["not-found", "conflict", "not-builtin"] as const)(
    "服务拒绝 %s：带同名错误码回到列表，不刷新任何路径",
    async (code) => {
      dependencies.reset.mockResolvedValue({ ok: false, code });
      await expect(resetThemePackAction(form(VALID))).rejects.toThrow(`/admin/themes?err=${code}`);
      expect(redirected()).toEqual([`/admin/themes?err=${code}`]);
      expect(dependencies.revalidate).not.toHaveBeenCalled();
    },
  );

  it("服务异常原样抛出：不回跳成功、不刷新路径", async () => {
    dependencies.reset.mockRejectedValue(new Error("事务失败"));
    await expect(resetThemePackAction(form(VALID))).rejects.toThrow("事务失败");
    expect(dependencies.redirect).not.toHaveBeenCalled();
    expect(dependencies.revalidate).not.toHaveBeenCalled();
  });

  it.each([
    ["缺少 revision", { id: "qy2010" }],
    ["revision 为空串", { id: "qy2010", revision: "" }],
    ["revision 为 0", { id: "qy2010", revision: "0" }],
    ["revision 为负数", { id: "qy2010", revision: "-3" }],
    ["revision 为小数", { id: "qy2010", revision: "1.5" }],
    ["revision 不是数字", { id: "qy2010", revision: "abc" }],
    ["缺少 id", { revision: "4" }],
    ["id 超过 32 位", { id: "a".repeat(33), revision: "4" }],
  ])("输入不合法（%s）：直接拒绝，不调用服务也不回跳", async (_label, fields) => {
    await expect(resetThemePackAction(form(fields))).rejects.toThrow("invalid-input");
    expect(dependencies.reset).not.toHaveBeenCalled();
    expect(dependencies.redirect).not.toHaveBeenCalled();
    expect(dependencies.revalidate).not.toHaveBeenCalled();
  });
});
