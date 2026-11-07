/**
 * 运营排期页测试（M11.4 Step 0）：回执码与页面文案成对（G-15）——
 * 写服务的每个失败码、Action 发出的每个成功回执都有专门文案，不落到通用兜底；
 * 只有未知码（含 `toString` 这类原型属性名）才走兜底。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CampaignsAdminPage from "@/app/admin/campaigns/page";
import type { CampaignErrorCode } from "@/lib/campaigns/admin";

vi.mock("@/lib/authz/require-admin", () => ({
  requireAdmin: async () => ({ userId: 1, ip: null }),
}));
vi.mock("@/lib/campaigns/list", () => ({
  listCampaigns: async () => ({ items: [], now: "2026-11-07 12:00:00" }),
}));
vi.mock("@/lib/theme/catalog", () => ({
  getThemeCatalog: async () => [{ id: "default", label: "默认" }],
}));
vi.mock("@/lib/brand/logo-pool", () => ({
  getLogoPoolRaw: async () => ({
    items: [{ file: "logo-aaaa1111.png", name: "青翼 LOGO" }],
    active: null,
  }),
}));
vi.mock("@/lib/brand/hero-pool", () => ({
  getHeroPoolRaw: async () => ({
    items: [{ file: "hero-bbbb2222.png", name: "秋季横幅" }],
    active: null,
  }),
}));
vi.mock("@/app/admin/campaigns/actions", () => ({
  createCampaignAction: vi.fn(),
  updateCampaignAction: vi.fn(),
  toggleCampaignAction: vi.fn(),
  deleteCampaignAction: vi.fn(),
}));

const page = (searchParams: Record<string, string> = {}) =>
  CampaignsAdminPage({ searchParams: Promise.resolve(searchParams) });

const FALLBACK = "操作失败，请重试。";

// 键类型取自写服务的失败码：服务新增失败码而这里没补期望文案，类型检查就会报错（G-15）
const ERROR_TEXT: Record<CampaignErrorCode, string> = {
  "bad-name": "方案名称不能为空，且不超过 60 个字符。",
  "bad-effect": "请选择要生效的内容。",
  "bad-target": "所选内容的格式不合法。",
  "bad-start": "开始时间格式不合法。",
  "bad-end": "结束时间格式不合法。",
  "bad-window": "结束时间必须晚于开始时间。",
  "bad-priority": "优先级须为 0–65535 的整数。",
  "missing-ref": "所选主题包已停用或不存在，或素材已不在素材池中，请重新选择。",
  "not-found": "方案不存在或已被删除。",
  conflict: "方案已被他人修改（版本冲突）。",
};

const SAVED_TEXT: Record<string, string> = {
  created: "排期方案已创建。",
  updated: "排期方案已保存。",
  toggled: "排期方案状态已更新。",
  deleted: "排期方案已删除。",
};

/** Action 实际发出的成功回执码：从源码里扫出来，新增回执而期望表没跟上即红 */
const ACTIONS_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "actions.ts"),
  "utf8",
);
const savedCodesInActions = () =>
  new Set([...ACTIONS_SRC.matchAll(/[?&]saved=([a-z_-]+)/g)].map((match) => match[1]));

describe("运营排期页：回执码与文案成对（G-15）", () => {
  it.each(Object.entries(ERROR_TEXT))("失败码 %s 渲染专门提示", async (code, text) => {
    render(await page({ err: code }));
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(text);
    expect(alert).not.toHaveTextContent(FALLBACK);
  });

  it("未知失败码与原型属性名才落到通用兜底（证明上面的专门提示不是兜底文案）", async () => {
    for (const err of ["no-such-code", "toString", "constructor"]) {
      const { unmount } = render(await page({ err }));
      expect(screen.getByRole("alert")).toHaveTextContent(FALLBACK);
      unmount();
    }
  });

  it("Action 发出的成功回执码与期望表一致（扫描 actions.ts，防止扫空）", () => {
    expect(savedCodesInActions()).toEqual(new Set(Object.keys(SAVED_TEXT)));
  });

  it.each(Object.entries(SAVED_TEXT))("成功回执 %s 有专门文案", async (saved, text) => {
    render(await page({ saved }));
    expect(screen.getByRole("status")).toHaveTextContent(text);
  });

  it("未知成功回执与原型属性名不显示任何提示", async () => {
    for (const saved of ["no-such-code", "toString"]) {
      const { unmount } = render(await page({ saved }));
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      unmount();
    }
  });
});
