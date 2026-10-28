import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrefToggleButton } from "./pref-toggles";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const setup = (enabled = true) =>
  render(
    <PrefToggleButton
      type="post.replied"
      channel="in_app"
      initialEnabled={enabled}
      onLabel="站内通知已开启"
      offLabel="站内通知已关闭"
      label="新回复 · 站内通知"
    />,
  );
const sw = () => screen.getByRole("switch", { name: "新回复 · 站内通知" });

beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("PrefToggleButton（通知偏好开关）", () => {
  it("初始状态取自 initialEnabled", () => {
    setup(false);
    expect(sw()).toHaveAttribute("aria-checked", "false");
  });

  it("点击乐观切换：服务端还没返回就已变化；PATCH 带着 type / channel / enabled；成功 toast", async () => {
    let finish!: (r: Response) => void;
    const fetchMock = vi.fn().mockReturnValue(new Promise<Response>((r) => (finish = r)));
    vi.stubGlobal("fetch", fetchMock);
    setup(true);
    await userEvent.click(sw());
    expect(sw()).toHaveAttribute("aria-checked", "false"); // 乐观
    expect(sw()).toBeDisabled(); // 进行中不可连点
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/settings/preferences");
    expect(JSON.parse(init.body)).toEqual({
      kind: "notif",
      type: "post.replied",
      channel: "in_app",
      enabled: false,
    });
    await act(async () => finish(new Response(null, { status: 204 })));
    expect(toast.success).toHaveBeenCalledWith("站内通知已关闭");
    expect(sw()).toHaveAttribute("aria-checked", "false");
  });

  it("失败（非 2xx）：回滚并 toast「保存失败，请重试」", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    setup(true);
    await userEvent.click(sw());
    expect(toast.error).toHaveBeenCalledWith("保存失败，请重试");
    expect(sw()).toHaveAttribute("aria-checked", "true");
  });

  it("网络错误：同样回滚", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    setup(false);
    await userEvent.click(sw());
    expect(toast.error).toHaveBeenCalledWith("保存失败，请重试");
    expect(sw()).toHaveAttribute("aria-checked", "false");
  });
});
