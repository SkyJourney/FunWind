import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 安装向导页测试（M12 Step 3）：
 *  · G-15：每个管线错误码都有专门文案（类型表键取自失败码联合），未知码落兜底；
 *  · 分步渲染：按进度/参数决定当前步，完成步展示引导链接；
 *  · 草稿回显（G-19）：失败跳回时字段保留提交值。
 */
const state = vi.hoisted(() => ({
  installed: false,
  progress: { dbReady: false, siteConfigured: false, adminCreated: false },
  nodeOk: true,
  storageOk: true,
}));

vi.mock("@/lib/install/guard", () => ({ requireNotInstalled: vi.fn(async () => undefined) }));
vi.mock("@/lib/install/progress", () => ({
  installProgress: async () => state.progress,
  nodeVersionOk: () => state.nodeOk,
  storageWritable: async () => state.storageOk,
  REQUIRED_NODE_MAJOR: 24,
  stepOfProgress: (p: { adminCreated: boolean; siteConfigured: boolean; dbReady: boolean }) =>
    p.adminCreated ? 4 : p.siteConfigured ? 3 : p.dbReady ? 2 : 1,
}));
vi.mock("@/app/install/actions", () => ({
  installDatabaseAction: vi.fn(),
  installSiteAction: vi.fn(),
  installAdminAction: vi.fn(),
}));

import InstallPage from "@/app/install/page";

const page = (searchParams: Record<string, string> = {}) =>
  InstallPage({ searchParams: Promise.resolve(searchParams) });

const FALLBACK = "安装失败，请重试。";

/** 错误码 ↔ 文案成对（G-15）：键类型必须覆盖管线失败码联合——新增码而这里没补文案，类型检查即红 */
const ERROR_TEXT: Record<
  | "already-installed"
  | "invalid-config"
  | "db-unreachable"
  | "db-create-denied"
  | "bootstrap-failed"
  | "users-exist",
  string
> = {
  "db-unreachable": "无法连接数据库：请核对主机、端口、用户与口令后重试。",
  "db-create-denied": "创建数据库失败",
  "bootstrap-failed": "建表或系统种子失败",
  "users-exist": "数据库已有用户，拒绝写入",
  "already-installed": "站点已完成安装",
  "invalid-config": "提交的配置有格式问题",
};

beforeEach(() => {
  state.installed = false;
  state.progress = { dbReady: false, siteConfigured: false, adminCreated: false };
  state.nodeOk = true;
  state.storageOk = true;
});

describe("安装向导页", () => {
  it("默认渲染第 1 步：环境自检（Node/数据目录）与数据库表单（预填 .env 主机）", async () => {
    render(await page());
    expect(screen.getByText("环境自检")).toBeTruthy();
    expect(screen.getByText(/数据目录可写：是/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "测试连接并建表" })).toBeTruthy();
    expect((screen.getByLabelText("主机") as HTMLInputElement).value).toContain("127.0.0.1");
  });

  it("Node 版本不足与数据目录不可写时如实展示", async () => {
    state.nodeOk = false;
    state.storageOk = false;
    render(await page());
    expect(screen.getByText(/低于要求的 v24/)).toBeTruthy();
    expect(screen.getByText(/数据目录可写：否/)).toBeTruthy();
  });

  it.each(Object.entries(ERROR_TEXT))("失败码 %s 渲染专门文案（G-15）", async (code, text) => {
    render(await page({ step: "1", err: code }));
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(text);
    expect(alert).not.toHaveTextContent(FALLBACK);
  });

  it("未知错误码落通用兜底（对照用例）", async () => {
    render(await page({ step: "1", err: "no-such-code" }));
    expect(screen.getByRole("alert")).toHaveTextContent(FALLBACK);
  });

  it("失败跳回时草稿回显：字段保留提交值（G-19）", async () => {
    const draft = encodeURIComponent(
      JSON.stringify({
        db: {
          host: "db.internal",
          port: "33621",
          user: "root",
          password: "pw",
          name: "qysub_next",
        },
      }),
    );
    render(await page({ step: "1", err: "db-unreachable", draft }));
    expect((screen.getByLabelText("主机") as HTMLInputElement).value).toBe("db.internal");
    expect((screen.getByLabelText("端口") as HTMLInputElement).value).toBe("33621");
  });

  it("进度推导：bootstrap 后默认第 2 步；设置后第 3 步；管理员后第 4 步（完成页含引导链接）", async () => {
    state.progress = { dbReady: true, siteConfigured: false, adminCreated: false };
    render(await page());
    expect(screen.getByRole("button", { name: "保存站点设置" })).toBeTruthy();

    state.progress = { dbReady: true, siteConfigured: true, adminCreated: false };
    render(await page());
    expect(screen.getByRole("button", { name: "创建管理员并完成安装" })).toBeTruthy();

    state.progress = { dbReady: true, siteConfigured: true, adminCreated: true };
    const { unmount } = render(await page());
    expect(screen.getByRole("status")).toHaveTextContent("安装完成");
    expect(screen.getByRole("link", { name: /前往登录/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /从青翼 phpwind 导入/ })).toBeTruthy();
    unmount();
  });

  it("step=2 的失败回显保留草稿（站点名），进度已到第 2 步时 clamp 放行", async () => {
    // 进度 dbReady=true → maxStep=2，step=2 合法放行（审查 F-2 的 clamp 语义）
    state.progress = { dbReady: true, siteConfigured: false, adminCreated: false };
    const draft = encodeURIComponent(
      JSON.stringify({
        site: { name: "我的站", tagline: "", url: "http://x" },
        registration: { mode: "open" },
      }),
    );
    render(
      await page({
        step: "2",
        err: "invalid-config",
        draft,
        issues: encodeURIComponent(JSON.stringify({ "site.name": "名称必填" })),
      }),
    );
    // 字段级问题 span 渲染在 label 内部：label 文本含提示尾巴，用子串匹配
    expect((screen.getByLabelText("站点名称", { exact: false }) as HTMLInputElement).value).toBe(
      "我的站",
    );
    expect(screen.getByText("名称必填")).toBeTruthy();
  });

  it("跳步 clamp：进度未到时 ?step=2/4 被压回推导步（F-2）", async () => {
    // 进度全 false → maxStep=1：step=2/4 都渲染第 1 步
    render(await page({ step: "2" }));
    expect(screen.getByRole("button", { name: "测试连接并建表" })).toBeTruthy();
    const { unmount } = render(await page({ step: "4" }));
    expect(screen.queryByText("安装完成")).toBeNull();
    unmount();
  });
});
