import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 板块目录页零数据空态（M12 Step 4）：安装后尚无版块时，
 * 管理员直达后台建版块；访客按注册策略给「注册账号」或「登录」。
 */
const mocks = vi.hoisted(() => ({
  subject: vi.fn(),
  directory: vi.fn(),
  perm: vi.fn(),
  chrome: vi.fn(),
}));
vi.mock("@/lib/authz/subject", () => ({ getCurrentSubject: mocks.subject }));
vi.mock("@/lib/queries/forums", () => ({ getDirectory: mocks.directory }));
vi.mock("@/lib/authz/service", () => ({ checkPermission: mocks.perm }));
vi.mock("@/lib/chrome/site-chrome", () => ({ getSiteChrome: mocks.chrome }));
vi.mock("@/components/content/forum-directory", () => ({ ForumDirectory: () => null }));

import BoardsPage from "./page";

const emptyDir = () => ({ groups: [], forumCount: 0, threadCount: 0 });

beforeEach(() => {
  mocks.subject.mockResolvedValue({ userId: null });
  mocks.directory.mockResolvedValue(emptyDir());
  mocks.perm.mockResolvedValue({ allowed: false, via: "deny" });
  mocks.chrome.mockResolvedValue({ registrationOpen: true });
});

describe("板块目录零数据空态（M12）", () => {
  it("零数据 + 管理员：主行动直达后台建版块，说明写明零数据站点", async () => {
    mocks.perm.mockResolvedValue({ allowed: true, via: "test" });
    render(await BoardsPage());
    expect(screen.getByText("这里还没有板块")).toBeInTheDocument();
    expect(screen.getByText(/零数据站点：创建第一个版块/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /进后台创建第一个版块/ })).toHaveAttribute(
      "href",
      "/admin/forums",
    );
    expect(screen.getByText("0 个板块 · 0 个主题")).toBeInTheDocument();
  });

  it("零数据 + 访客 + 注册开放：主行动为注册账号", async () => {
    render(await BoardsPage());
    expect(screen.getByRole("link", { name: /注册账号/ })).toHaveAttribute("href", "/register");
    expect(screen.getByText(/站长正在准备社区/)).toBeInTheDocument();
  });

  it("零数据 + 访客 + 注册关闭（双关）：主行动退化为登录", async () => {
    mocks.chrome.mockResolvedValue({ registrationOpen: false });
    render(await BoardsPage());
    expect(screen.getByRole("link", { name: "登录 →" })).toHaveAttribute("href", "/login");
    expect(screen.queryByRole("link", { name: /注册账号/ })).toBeNull();
  });

  it("非空目录：正常渲染计数，无空态", async () => {
    mocks.directory.mockResolvedValue({ groups: [], forumCount: 5, threadCount: 42 });
    render(await BoardsPage());
    expect(screen.getByText("5 个板块 · 42 个主题")).toBeInTheDocument();
    expect(screen.queryByText("这里还没有板块")).toBeNull();
  });
});
