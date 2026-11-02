import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryToast } from "./query-toast";

const state = vi.hoisted(() => ({
  pathname: "/t/123",
  params: new URLSearchParams(),
  router: { replace: vi.fn() },
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
  useSearchParams: () => state.params,
  useRouter: () => state.router,
}));
vi.mock("sonner", () => ({ toast: state.toast }));

beforeEach(() => {
  vi.clearAllMocks();
  state.pathname = "/t/123";
  state.params = new URLSearchParams();
  window.history.replaceState(null, "", "/t/123");
});

describe("QueryToast", () => {
  it("互动频控显示错误提示，只清 notice，保留分页、内联错误及帖子锚点", () => {
    state.params = new URLSearchParams("page=2&notice=interact-rate&error=existing");
    window.history.replaceState(null, "", "/t/123?page=2&notice=interact-rate#error-anchor");
    render(<QueryToast />);
    expect(state.toast.error).toHaveBeenCalledWith("操作过于频繁，请稍后再试。");
    expect(state.toast.success).not.toHaveBeenCalled();
    expect(state.router.replace).toHaveBeenCalledWith("/t/123?page=2&error=existing#error-anchor", {
      scroll: false,
    });
  });

  it("偏好频控码同样显示错误提示并被清理", () => {
    state.pathname = "/settings";
    state.params = new URLSearchParams("notice=preferences-rate");
    render(<QueryToast />);
    expect(state.toast.error).toHaveBeenCalledWith("操作过于频繁，请稍后再试。");
    expect(state.toast.success).not.toHaveBeenCalled();
    expect(state.router.replace).toHaveBeenCalledWith("/settings", { scroll: false });
  });

  it("仅 notice 时清理为原路径并保留锚点", () => {
    state.params = new URLSearchParams("notice=interact-rate");
    window.history.replaceState(null, "", "/t/123?notice=interact-rate#p456");
    render(<QueryToast />);
    expect(state.router.replace).toHaveBeenCalledWith("/t/123#p456", { scroll: false });
  });

  it("既有成功码仍显示成功提示", () => {
    state.params = new URLSearchParams("notice=pm-policy-saved");
    render(<QueryToast />);
    expect(state.toast.success).toHaveBeenCalledWith("私信权限已更新。");
    expect(state.toast.error).not.toHaveBeenCalled();
    expect(state.router.replace).toHaveBeenCalledWith("/t/123", { scroll: false });
  });

  it("只有 error 时保留页面内联反馈，不消费或清理", () => {
    state.params = new URLSearchParams("error=rate");
    render(<QueryToast />);
    expect(state.toast.success).not.toHaveBeenCalled();
    expect(state.toast.error).not.toHaveBeenCalled();
    expect(state.router.replace).not.toHaveBeenCalled();
  });

  it.each(["/login", "/register", "/admin/reports"])("%s 保持内联反馈页的既有跳过约定", (path) => {
    state.pathname = path;
    state.params = new URLSearchParams("notice=interact-rate&error=existing");
    render(<QueryToast />);
    expect(state.toast.success).not.toHaveBeenCalled();
    expect(state.toast.error).not.toHaveBeenCalled();
    expect(state.router.replace).not.toHaveBeenCalled();
  });
});
