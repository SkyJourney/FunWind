/**
 * 主题管理列表页测试（M11.6 Step 3f）：内置包的「重置为内置定义」入口——
 * 只在内置行出现、隐藏字段取自各自那一行、先确认再提交、提交中不可重复点、
 * 成功提示与全部错误码都有对应渲染（G-15，不落到通用兜底文案）。
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import ThemesAdminPage from "@/app/admin/themes/page";
import type { ThemePackSummary } from "@/lib/theme/packs";
import type { ThemePackResetResult } from "@/lib/theme/pack-reset";

const services = vi.hoisted(() => ({
  packs: [] as ThemePackSummary[],
  reset: vi.fn(async (_data: FormData) => {}),
}));
vi.mock("@/lib/authz/require-admin", () => ({
  requireAdmin: async () => ({ userId: 1, ip: null }),
}));
vi.mock("@/lib/theme/packs", () => ({
  MAX_ENABLED_THEME_PACKS: 5,
  listThemePacks: async () => services.packs,
  getSiteDefaultThemePack: async () => "default",
  getThemePack: async () => ({ definition: { surfaces: {} } }),
  getEnabledThemePackCount: async () => services.packs.filter((pack) => pack.enabled).length,
}));
vi.mock("@/app/admin/themes/actions", () => ({
  copyThemePackAction: vi.fn(),
  createThemePackAction: vi.fn(),
  deleteThemePackAction: vi.fn(),
  resetThemePackAction: services.reset,
  setDefaultThemePackAction: vi.fn(),
  toggleThemePackAction: vi.fn(),
}));
vi.mock("@/components/admin/theme-pack-import-form", () => ({ ThemePackImportForm: () => null }));

function summary(over: Partial<ThemePackSummary>): ThemePackSummary {
  return {
    id: "x",
    name: "X",
    description: "",
    enabled: true,
    isBuiltin: false,
    revision: 1,
    surfaces: 0,
    assetCount: 0,
    updatedAt: "2026-01-01 00:00:00",
    ...over,
  };
}

const initial = [
  summary({ id: "default", name: "默认", isBuiltin: true, revision: 3 }),
  summary({ id: "qy2010", name: "青翼 2010", isBuiltin: true, revision: 9 }),
  summary({ id: "mine", name: "我的", revision: 2 }),
];
services.packs = initial;

const page = (searchParams: Record<string, string> = {}) =>
  ThemesAdminPage({ searchParams: Promise.resolve(searchParams) });

/** 含 revision 隐藏字段的表单就是重置表单（其余表单只有 id / enabled / sourceId 等） */
const resetForms = (root: HTMLElement) =>
  Array.from(root.querySelectorAll<HTMLFormElement>("form")).filter((form) =>
    form.querySelector('input[name="revision"]'),
  );
const field = (form: HTMLFormElement, name: string) =>
  form.querySelector<HTMLInputElement>(`input[name="${name}"]`)!.value;
const formOf = (root: HTMLElement, id: string) =>
  resetForms(root).find((form) => field(form, "id") === id)!;
const TRIGGER = { name: "重置为内置定义" };

afterEach(() => {
  services.packs = initial;
  services.reset.mockReset();
  services.reset.mockImplementation(async () => {});
});

describe("主题管理列表：内置包重置入口（M11.6 Step 3f）", () => {
  it("只有内置包的行带重置表单，隐藏的 id 与 revision 取自各自那一行", async () => {
    const { container } = render(await page());
    expect(
      resetForms(container).map((form) => [field(form, "id"), field(form, "revision")]),
    ).toEqual([
      ["default", "3"],
      ["qy2010", "9"],
    ]);
    expect(screen.getAllByRole("button", TRIGGER)).toHaveLength(2);
  });

  it("点击先弹出确认框并说明保留项，取消不提交；确认后带本行的 id 与 revision 提交一次", async () => {
    const user = userEvent.setup();
    const { container } = render(await page());
    const form = formOf(container, "qy2010");

    await user.click(within(form).getByRole("button", TRIGGER));
    const dialog = await screen.findByRole("dialog", { name: "重置为内置定义？" });
    expect(dialog).toHaveTextContent("名称、说明、启停状态与 LOGO 保持不变");
    expect(dialog).toHaveTextContent("不可撤销");
    expect(dialog).toHaveTextContent("导出 ZIP");
    expect(services.reset).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(services.reset).not.toHaveBeenCalled();

    await user.click(within(form).getByRole("button", TRIGGER));
    const again = await screen.findByRole("dialog");
    await user.click(within(again).getByRole("button", { name: "确认" }));
    await waitFor(() => expect(services.reset).toHaveBeenCalledTimes(1));
    const data = services.reset.mock.calls[0]![0];
    expect([data.get("id"), data.get("revision")]).toEqual(["qy2010", "9"]);
  });

  it("提交进行中按钮显示「重置中…」并禁用，完成后恢复", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    services.reset.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { container } = render(await page());
    const form = formOf(container, "default");

    await user.click(within(form).getByRole("button", TRIGGER));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "确认" }),
    );
    expect(await within(form).findByRole("button", { name: "重置中…" })).toBeDisabled();

    await act(async () => release());
    await waitFor(() => expect(within(form).getByRole("button", TRIGGER)).toBeEnabled());
  });

  it("成功回执 saved=reset 有专门文案，不落到通用兜底", async () => {
    render(await page({ saved: "reset" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "已重置为内置定义（名称、说明、启停状态与 LOGO 保持不变）。",
    );
  });

  // 键类型取自服务的失败码：服务新增失败码而这里没补文案，类型检查就会报错（G-15）
  const RESET_ERROR_TEXT: Record<Extract<ThemePackResetResult, { ok: false }>["code"], string> = {
    "not-found": "包不存在。",
    conflict: "版本冲突",
    "not-builtin": "只有内置主题包可以重置为内置定义。",
  };
  it.each(Object.entries(RESET_ERROR_TEXT))("失败码 %s 渲染专门提示", async (code, text) => {
    render(await page({ err: code }));
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(text);
    expect(alert).not.toHaveTextContent("操作失败，请重试。");
  });

  it("未知失败码才落到通用兜底（用来证明上面的专门提示不是兜底文案）", async () => {
    render(await page({ err: "no-such-code" }));
    expect(screen.getByRole("alert")).toHaveTextContent("操作失败，请重试。");
  });
});
