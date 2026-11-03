import { fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ThemePackEditPage from "@/app/admin/themes/[id]/page";
import type { ThemePackDefinition } from "@/lib/theme/surface-schema";

const services = vi.hoisted(() => ({
  userId: 7,
  pack: {
    id: "test",
    revision: 4,
    name: "服务端名称",
    description: "服务端说明",
    definition: {
      pwa: { themeColor: "#123456", backgroundColor: "#abcdef" },
      surfaces: { header: { light: { fill: { type: "solid", color: "#ffffff" } } } },
    } as ThemePackDefinition,
    assets: [],
    isBuiltin: false,
  },
  action: vi.fn(async (_data: FormData) => {}),
}));
vi.mock("@/lib/authz/require-admin", () => ({
  requireAdmin: async () => ({ userId: services.userId, ip: null }),
}));
vi.mock("@/lib/brand/decor-pool", () => ({ getDecorPoolRaw: async () => ({ items: [] }) }));
vi.mock("@/lib/brand/logo-pool", () => ({ getLogoPoolRaw: async () => ({ items: [] }) }));
vi.mock("@/lib/theme/packs", () => ({
  getThemePack: async () => services.pack,
  getDecorUsage: async () => new Map(),
  parseThemePackAssets: () => [],
}));
vi.mock("@/app/theme-preview-actions", () => ({ startThemePreviewAction: async () => {} }));
vi.mock("@/app/admin/themes/actions", () => ({ saveThemePackAction: services.action }));
vi.mock("@/components/admin/theme-logo-manager", () => ({ ThemeLogoManager: () => null }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  notFound: () => {
    throw new Error("404");
  },
}));

async function page(error?: string) {
  return ThemePackEditPage({
    params: Promise.resolve({ id: "test" }),
    searchParams: Promise.resolve({ err: error }),
  });
}
const field = (name: string) => screen.getByRole("textbox", { name });
const revision = (container: HTMLElement) =>
  container.querySelector<HTMLInputElement>('input[name="revision"]')!.value;

const initial = structuredClone(services.pack);
afterEach(() => {
  services.pack = structuredClone(initial);
  services.userId = 7;
  services.action.mockClear();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe("主题编辑页：真实接线的 G-19 回归", () => {
  it("真实输入经错误页重建后保留名称、说明、定义和原版本，并禁止静默再提交", async () => {
    const first = render(await page());
    fireEvent.change(field("主题名称"), { target: { value: "我的未保存名称" } });
    fireEvent.change(field("说明"), { target: { value: "我的未保存说明" } });
    fireEvent.change(screen.getByTestId("theme-fill-solid-color"), {
      target: { value: "#13579b" },
    });
    first.unmount();
    services.pack = {
      ...services.pack,
      revision: 5,
      name: "他人已保存名称",
      description: "他人已保存说明",
      definition: {
        ...services.pack.definition,
        surfaces: { header: { light: { fill: { type: "solid", color: "#654321" } } } },
      },
    };
    const concurrent = structuredClone(services.pack);
    const { container } = render(await page("conflict"));
    expect(field("主题名称")).toHaveValue("我的未保存名称");
    expect(field("说明")).toHaveValue("我的未保存说明");
    expect(screen.getByTestId("theme-fill-solid-color")).toHaveValue("#13579b");
    expect(revision(container)).toBe("4");
    const save = screen.getByRole("button", { name: "保存主题包" });
    expect(save).toBeDisabled();
    fireEvent.submit(save.closest("form")!);
    expect(services.action).not.toHaveBeenCalled();
    expect(services.pack).toEqual(concurrent);
    expect(screen.queryByText(/请刷新页面后重试/)).not.toBeInTheDocument();
  });

  it("服务端 surfaces 每次建立新引用，普通同树刷新不清理已输入草稿", async () => {
    const { rerender } = render(await page());
    fireEvent.change(field("主题名称"), { target: { value: "当前输入" } });
    fireEvent.change(screen.getByTestId("theme-fill-solid-color"), {
      target: { value: "#13579b" },
    });
    const before = { ...sessionStorage };
    expect(Object.keys(before).length).toBeGreaterThan(0);
    rerender(await page());
    expect({ ...sessionStorage }).toEqual(before);
    expect(field("主题名称")).toHaveValue("当前输入");
    expect(screen.getByTestId("theme-fill-solid-color")).toHaveValue("#13579b");
  });

  it("StrictMode 首次进入不把初始定义当用户工作成果写入本地档", async () => {
    const write = vi.spyOn(Storage.prototype, "setItem");
    render(<StrictMode>{await page()}</StrictMode>);
    expect(write).not.toHaveBeenCalled();
  });

  it("服务端身份切换后不能恢复上一账号名称或配置", async () => {
    const first = render(await page());
    fireEvent.change(field("主题名称"), { target: { value: "账号七的草稿" } });
    fireEvent.change(screen.getByTestId("theme-fill-solid-color"), {
      target: { value: "#13579b" },
    });
    first.unmount();
    services.userId = 8;
    render(await page("conflict"));
    expect(field("主题名称")).toHaveValue(initial.name);
    expect(screen.getByTestId("theme-fill-solid-color")).toHaveValue("#ffffff");
  });
});
