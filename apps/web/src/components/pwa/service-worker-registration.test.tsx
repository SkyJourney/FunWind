// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceWorkerRegistration } from "./service-worker-registration";

const toast = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const register = vi.fn(async () => undefined);
const listeners = new Set<() => void>();
const sw = {
  register,
  addEventListener: (type: string, fn: () => void) => {
    if (type === "controllerchange") listeners.add(fn);
  },
  removeEventListener: (type: string, fn: () => void) => {
    if (type === "controllerchange") listeners.delete(fn);
  },
  controller: null as unknown,
};
const controllerChange = () => {
  for (const fn of listeners) fn();
};

beforeEach(() => {
  vi.clearAllMocks();
  listeners.clear();
  sw.controller = null;
  // 只替换 serviceWorker，不整体替身 navigator（展开会丢原型上的方法，测试环境自身会用到）
  Object.defineProperty(window.navigator, "serviceWorker", { configurable: true, value: sw });
  vi.stubEnv("NODE_ENV", "production");
});
afterEach(() => {
  vi.unstubAllEnvs();
  Reflect.deleteProperty(window.navigator, "serviceWorker");
});

describe("ServiceWorkerRegistration（M16.1 Step 3）", () => {
  it("注册 URL 带部署版本：sw.js 是静态文件，不带版本浏览器不会重装", () => {
    render(<ServiceWorkerRegistration version="build-abc123" />);
    expect(register).toHaveBeenCalledWith("/sw.js?v=build-abc123", { scope: "/" });
  });

  it("首次安装接管不提示更新（加载时没有 controller）", () => {
    render(<ServiceWorkerRegistration version="v1" />);
    controllerChange(); // 首装 + clients.claim 也会触发
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("已有 controller 时换控制者：提示已更新，带刷新动作且常驻", () => {
    sw.controller = {}; // 页面加载时就被旧 SW 接管
    render(<ServiceWorkerRegistration version="v2" />);
    controllerChange();
    expect(toast.info).toHaveBeenCalledWith(
      "站点已更新",
      expect.objectContaining({
        id: "fw-sw-updated",
        duration: Infinity,
        action: expect.objectContaining({ label: "刷新" }),
      }),
    );
  });

  it("反复接管只提示一次（不刷屏）", () => {
    sw.controller = {};
    render(<ServiceWorkerRegistration version="v2" />);
    controllerChange();
    controllerChange();
    controllerChange();
    expect(toast.info).toHaveBeenCalledTimes(1);
  });

  it("注册失败静默吞掉：不影响在线使用", async () => {
    register.mockRejectedValueOnce(new Error("boom"));
    expect(() => render(<ServiceWorkerRegistration version="v1" />)).not.toThrow();
    await Promise.resolve();
  });

  it("卸载后摘掉 controllerchange 监听", () => {
    const { unmount } = render(<ServiceWorkerRegistration version="v1" />);
    expect(listeners.size).toBe(1);
    unmount();
    expect(listeners.size).toBe(0);
  });

  it("开发模式不注册（避免 HMR 与缓存互相污染）", () => {
    vi.stubEnv("NODE_ENV", "development");
    render(<ServiceWorkerRegistration version="v1" />);
    expect(register).not.toHaveBeenCalled();
  });
});
