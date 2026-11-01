import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "next-themes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PackOptionsRow, ThemeMenu } from "./theme-menu";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const setupRow = (user: "default" | "qy2010" | null = null) =>
  render(<PackOptionsRow pref={{ user, site: "default" }} />);
const btn = (name: string) => screen.getByRole("button", { name });
const patchBody = (fetchMock: ReturnType<typeof vi.fn>) =>
  JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string) as unknown;

beforeEach(() => {
  document.documentElement.dataset.pack = "default";
  toast.error.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("PackOptionsRow（用户菜单主题包行）", () => {
  it("渲染「跟随站点」+ 注册表全部包；初始选中态取自 pref.user", () => {
    setupRow("qy2010");
    expect(btn("跟随站点")).toHaveAttribute("aria-pressed", "false");
    expect(btn("复刻·青翼2010")).toHaveAttribute("aria-pressed", "true");
    expect(btn("现代浅色")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("group", { name: "主题包" })).toBeInTheDocument();
  });

  it("点选：html[data-pack] 立即生效（服务端未返回）+ PATCH themePack；成功后保持", async () => {
    let finish!: (r: Response) => void;
    const fetchMock = vi.fn().mockReturnValue(new Promise<Response>((r) => (finish = r)));
    vi.stubGlobal("fetch", fetchMock);
    setupRow(null);
    await userEvent.click(btn("复刻·青翼2010"));
    expect(document.documentElement.dataset.pack).toBe("qy2010"); // 乐观
    expect(btn("复刻·青翼2010")).toHaveAttribute("aria-pressed", "true");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/settings/preferences",
      expect.objectContaining({ method: "PATCH" }),
    );
    expect(patchBody(fetchMock)).toEqual({ kind: "themePack", pack: "qy2010" });
    await act(async () => {
      finish(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    });
    expect(document.documentElement.dataset.pack).toBe("qy2010");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("「跟随站点」：PATCH pack=null，属性回到站点默认值", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    document.documentElement.dataset.pack = "qy2010";
    setupRow("qy2010");
    await userEvent.click(btn("跟随站点"));
    expect(document.documentElement.dataset.pack).toBe("default");
    expect(patchBody(fetchMock)).toEqual({ kind: "themePack", pack: null });
  });

  it("持久化失败：属性与选中态回滚到之前值并 toast 报错", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
    setupRow(null);
    await userEvent.click(btn("复刻·青翼2010"));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(document.documentElement.dataset.pack).toBe("default");
    expect(btn("跟随站点")).toHaveAttribute("aria-pressed", "true");
    expect(btn("复刻·青翼2010")).toHaveAttribute("aria-pressed", "false");
  });
});

describe("ThemeMenu（顶栏图标下拉）", () => {
  it("游客（无 packPref）：有触发器、无主题包选项", () => {
    render(
      <ThemeProvider attribute="data-mode" defaultTheme="light" enableSystem={false}>
        <ThemeMenu />
      </ThemeProvider>,
    );
    expect(screen.getByRole("button", { name: "主题切换" })).toBeInTheDocument();
    expect(document.querySelectorAll("[data-pack-option]")).toHaveLength(0);
  });
});
