/**
 * LOGO 管理页测试（M11.6 Step 5b）：池项上的「〈主题包〉自带」徽标，包名取自数据库里的主题包行，
 * 不再读静态注册表（注册表里只剩 default，qy2010 与自定义包都在库里）。
 * BrandPoolAdmin 用替身渲染，只验证页面传给它的 itemBadge。
 */
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import LogoAdminPage from "@/app/admin/logo/page";
import type { BrandItem, BrandPool } from "@/lib/brand/brand-pool";
import type { ThemePackSummary } from "@/lib/theme/packs";

const state = vi.hoisted(() => ({
  pool: { items: [], active: null } as BrandPool,
  packs: [] as ThemePackSummary[],
  order: [] as string[],
}));

vi.mock("@/lib/authz/require-admin", () => ({
  requireAdmin: async () => {
    state.order.push("requireAdmin");
    return { userId: 1, ip: null };
  },
}));
vi.mock("@/lib/brand/logo-pool", () => ({
  getLogoPoolRaw: async () => {
    state.order.push("getLogoPoolRaw");
    return state.pool;
  },
}));
vi.mock("@/lib/brand/logo-pool-fs", () => ({ LOGO_MAX_BYTES: 512 * 1024 }));
vi.mock("@/lib/theme/packs", () => ({ listThemePacks: async () => state.packs }));
vi.mock("@/app/admin/logo/actions", () => ({
  removeLogoAction: vi.fn(),
  setActiveLogoAction: vi.fn(),
  uploadLogoAction: vi.fn(),
}));
vi.mock("@/components/admin/brand-pool-admin", () => ({
  BrandPoolAdmin: (props: {
    pool: BrandPool;
    itemBadge?: (item: BrandItem) => React.ReactNode;
  }) => (
    <ul>
      {props.pool.items.map((item) => (
        <li key={item.file} data-testid={item.file}>
          {props.itemBadge?.(item)}
        </li>
      ))}
    </ul>
  ),
}));

function pack(over: Partial<ThemePackSummary>): ThemePackSummary {
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

const render_ = async () => {
  render(await LogoAdminPage({ searchParams: Promise.resolve({}) }));
};

afterEach(() => {
  state.pool = { items: [], active: null };
  state.packs = [];
  state.order = [];
});

describe("LOGO 管理页：主题包自带徽标", () => {
  it("徽标显示数据库里该包当前的名称，而不是包 id", async () => {
    state.packs = [pack({ id: "qy2010", name: "复刻·青翼2010", isBuiltin: true })];
    state.pool = {
      items: [{ file: "logo-aa.png", name: "清爽侦探", pack: "qy2010" }],
      active: null,
    };
    await render_();
    expect(screen.getByTestId("logo-aa.png")).toHaveTextContent("复刻·青翼2010 自带");
    expect(screen.queryByText(/qy2010 自带/)).toBeNull();
  });

  it("自定义包同样显示自己的名称；改名后徽标跟着变", async () => {
    state.packs = [pack({ id: "xmas", name: "圣诞青翼" })];
    state.pool = { items: [{ file: "logo-bb.png", name: "圣诞", pack: "xmas" }], active: null };
    await render_();
    expect(screen.getByTestId("logo-bb.png")).toHaveTextContent("圣诞青翼 自带");
  });

  it("已停用的包也显示名称（池项还在，不能退化成 id）", async () => {
    state.packs = [pack({ id: "old-pk", name: "旧春节", enabled: false })];
    state.pool = { items: [{ file: "logo-cc.png", name: "旧", pack: "old-pk" }], active: null };
    await render_();
    expect(screen.getByTestId("logo-cc.png")).toHaveTextContent("旧春节 自带");
  });

  it("包已被删除（库里没有这一行）时退回显示包 id，不出现 undefined", async () => {
    state.packs = [];
    state.pool = { items: [{ file: "logo-dd.png", name: "遗留", pack: "gone-pk" }], active: null };
    await render_();
    const cell = screen.getByTestId("logo-dd.png");
    expect(cell).toHaveTextContent("gone-pk 自带");
    expect(cell.textContent).not.toContain("undefined");
  });

  it("没有 pack 标签的池项不显示徽标", async () => {
    state.packs = [pack({ id: "qy2010", name: "复刻·青翼2010" })];
    state.pool = { items: [{ file: "logo-ee.png", name: "手工上传" }], active: null };
    await render_();
    expect(screen.getByTestId("logo-ee.png")).toBeEmptyDOMElement();
  });

  it("入口鉴权仍是第一个动作（先于任何读数据）", async () => {
    await render_();
    expect(state.order[0]).toBe("requireAdmin");
  });
});
