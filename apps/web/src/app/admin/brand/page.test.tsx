/**
 * 品牌素材页测试（M19 Q2，原 logo/page.test.tsx 迁移）：kind→config 注入表——
 * 默认/非法 kind 回落 logo；hero 走横幅配置；LOGO 池项的「〈主题包〉自带」徽标取数据库包名；
 * 入口鉴权（requireAdmin）必须是第一个动作。
 * BrandPoolAdmin 用替身渲染，只验证页面传给它的配置。
 */
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import BrandAdminPage from "@/app/admin/brand/page";
import type { BrandItem, BrandPool } from "@/lib/brand/brand-pool";
import type { ThemePackSummary } from "@/lib/theme/packs";

const state = vi.hoisted(() => ({
  logoPool: { items: [], active: null } as BrandPool,
  heroPool: { items: [], active: null } as BrandPool,
  packs: [] as ThemePackSummary[],
  order: [] as string[],
  lastProps: null as Record<string, unknown> | null,
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
    return state.logoPool;
  },
}));
vi.mock("@/lib/brand/logo-pool-fs", () => ({ LOGO_MAX_BYTES: 512 * 1024 }));
vi.mock("@/lib/brand/hero-pool", () => ({
  getHeroPoolRaw: async () => {
    state.order.push("getHeroPoolRaw");
    return state.heroPool;
  },
}));
vi.mock("@/lib/brand/hero-pool-fs", () => ({
  HERO_MAX_BYTES: 2 * 1024 * 1024,
  HERO_MAX_WIDTH: 1920,
  HERO_MAX_HEIGHT: 1080,
}));
vi.mock("@/lib/theme/packs", () => ({ listThemePacks: async () => state.packs }));
vi.mock("@/app/admin/logo/actions", () => ({
  removeLogoAction: vi.fn(),
  setActiveLogoAction: vi.fn(),
  uploadLogoAction: vi.fn(),
}));
vi.mock("@/app/admin/hero/actions", () => ({
  removeHeroAction: vi.fn(),
  setActiveHeroAction: vi.fn(),
  uploadHeroAction: vi.fn(),
}));
vi.mock("@/components/admin/brand-pool-admin", () => ({
  BrandPoolAdmin: (props: Record<string, unknown>) => {
    state.lastProps = props;
    return null;
  },
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

const render_ = async (sp: Record<string, string> = {}) => {
  render(await BrandAdminPage({ searchParams: Promise.resolve(sp) }));
  return state.lastProps!;
};

afterEach(() => {
  state.logoPool = { items: [], active: null };
  state.heroPool = { items: [], active: null };
  state.packs = [];
  state.order = [];
  state.lastProps = null;
});

describe("品牌素材页：kind 配置注入", () => {
  it("默认 kind=logo：basePath/标题来自 LOGO 配置；入口鉴权是第一个动作", async () => {
    const props = await render_();
    expect(state.order[0]).toBe("requireAdmin");
    expect(state.order).toContain("getLogoPoolRaw");
    expect(props.basePath).toBe("/admin/brand?kind=logo");
    expect(props.title).toBe("LOGO 管理");
    expect(props.maxBytes).toBe(512 * 1024);
  });

  it("kind=hero：走横幅配置，不读 LOGO 池", async () => {
    const props = await render_({ kind: "hero" });
    expect(props.basePath).toBe("/admin/brand?kind=hero");
    expect(props.title).toBe("首页横幅");
    expect(state.order).toContain("getHeroPoolRaw");
    expect(state.order).not.toContain("getLogoPoolRaw");
  });

  it("非法 kind 回落 logo", async () => {
    const props = await render_({ kind: "decor" });
    expect(props.basePath).toBe("/admin/brand?kind=logo");
  });

  it("LOGO 徽标显示数据库里该包当前的名称；删除的包退回 id；无 pack 不显示徽标", async () => {
    state.packs = [
      pack({ id: "qy2010", name: "复刻·青翼2010", isBuiltin: true }),
      pack({ id: "old-pk", name: "旧春节", enabled: false }),
    ];
    state.logoPool = {
      items: [
        { file: "logo-aa.png", name: "清爽侦探", pack: "qy2010" },
        { file: "logo-cc.png", name: "旧", pack: "old-pk" },
        { file: "logo-dd.png", name: "遗留", pack: "gone-pk" },
        { file: "logo-ee.png", name: "手工上传" },
      ],
      active: null,
    };
    const { itemBadge } = await render_();
    const badgeOf = (item: BrandItem) => (itemBadge as (i: BrandItem) => React.ReactNode)(item);
    expect(badgeOf(state.logoPool.items[0]!)).toMatchSnapshot();
    expect(badgeOf(state.logoPool.items[1]!)).toMatchSnapshot();
    const goneJson = JSON.stringify(badgeOf(state.logoPool.items[2]!));
    expect(goneJson).toContain("gone-pk");
    expect(goneJson).toContain("自带");
    expect(goneJson).not.toContain("undefined");
    expect(badgeOf(state.logoPool.items[3]!)).toBeNull();
  });
});
