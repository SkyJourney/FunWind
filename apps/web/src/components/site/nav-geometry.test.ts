import { beforeEach, describe, expect, it } from "vitest";
import { resetExpandRecord, resolveNavGeometry, type NavStartInfo } from "./nav-geometry";

describe("resolveNavGeometry（触点扩散 / 收起）", () => {
  // pageTop = 顶栏等 chrome 的高度：圆心相对 [data-fw-page] 包装盒子，需要减掉它
  const viewport = { scrollY: 0, innerHeight: 800, innerWidth: 1000, pageTop: 57 };
  const farCorner = Math.hypot(700, 600); // 触点 (300,200) 到视口 1000×800 最远角的距离
  /** 一张内容卡片里的链接 */
  const cardLink = () => {
    document.body.innerHTML =
      '<article data-vt-expand><a href="/t/9">标题</a><a href="/f/3">板块</a></article>';
    return document.querySelectorAll("a");
  };
  const info = (over: Partial<NavStartInfo>): NavStartInfo => ({
    from: "/",
    to: "/t/9",
    anchor: null,
    point: { x: 300, y: 200 },
    ...over,
  });
  const back = (to: string, vp = viewport) =>
    resolveNavGeometry(info({ from: "/t/9", to, anchor: null, point: null }), vp);
  beforeEach(() => resetExpandRecord());

  it("内容卡片里的链接点进主题页 → expand，圆心 = 点击点换算成相对页面包装盒子的坐标（y 减去 pageTop）", () => {
    const [title] = cardLink();
    const { kind, origin } = resolveNavGeometry(info({ anchor: title! }), viewport);
    expect(kind).toBe("expand");
    expect(origin).toMatchObject({ x: 300, y: 200 - 57 });
  });

  it("终点半径 = 触点到视口最远角的距离（+余量）：圆长到它就恰好盖满，不浪费时间在屏幕之外", () => {
    const [title] = cardLink();
    const { origin } = resolveNavGeometry(info({ anchor: title! }), viewport);
    expect(origin!.r).toBeGreaterThanOrEqual(farCorner);
    expect(origin!.r).toBeLessThan(farCorner + 20);
  });

  it("范围只限主题页：卡片里的板块链接（前进到 /f/）是普通 push", () => {
    const [, forum] = cardLink();
    expect(resolveNavGeometry(info({ to: "/f/3", anchor: forum! }), viewport)).toEqual({
      kind: "push",
      origin: null,
    });
  });

  it("不在内容卡片里的链接（如顶栏）/ 没有点击点（重试）→ 普通 push", () => {
    document.body.innerHTML = '<header><a href="/t/9">x</a></header>';
    const a = document.querySelector("a")!;
    expect(resolveNavGeometry(info({ anchor: a }), viewport).kind).toBe("push");
    const [title] = cardLink();
    expect(resolveNavGeometry(info({ anchor: title!, point: null }), viewport).kind).toBe("push");
  });

  it("随后用站内链接回到打开它的列表页 → collapse，圆心 = 当时卡片的位置，半径盖满视口", () => {
    const [title] = cardLink();
    resolveNavGeometry(info({ from: "/f/3?page=2", anchor: title! }), viewport);
    const result = back("/f/3?page=2");
    expect(result.kind).toBe("collapse");
    expect(result.origin).toMatchObject({ x: 300, y: 200 - 57 });
    // 列表停在顶部：卡片在视口中的 y = docY = 200，与扩散时同一个最远角
    expect(result.origin!.r).toBeGreaterThanOrEqual(farCorner);
  });

  it("收起时详情页滚动过：旧页盒子顶 = pageTop − scrollY，圆心 y 要加回 scrollY", () => {
    const [title] = cardLink();
    resolveNavGeometry(info({ anchor: title! }), viewport); // 列表页 docY = 200
    const result = back("/", { ...viewport, scrollY: 500 });
    expect(result.kind).toBe("collapse");
    expect(result.origin).toMatchObject({ x: 300, y: 200 - 57 + 500 });
  });

  it("记录一次性：收起之后再返回同一页是普通 pop", () => {
    const [title] = cardLink();
    resolveNavGeometry(info({ anchor: title! }), viewport);
    expect(back("/").kind).toBe("collapse");
    expect(back("/").kind).toBe("pop");
  });

  it("卡片在第一屏之外（点击时已滚动很深）：找不到焦点，仍然 collapse，圆心 = 可视区域底部中心", () => {
    const [title] = cardLink();
    resolveNavGeometry(info({ anchor: title! }), { ...viewport, scrollY: 2000 }); // docY = 2200
    const result = back("/");
    expect(result.kind).toBe("collapse");
    // 视口底部中心 (500, 800)，换算成相对旧页包装盒子：y 减去 pageTop
    expect(result.origin).toMatchObject({ x: 500, y: 800 - 57 });
    expect(result.origin!.r).toBeGreaterThanOrEqual(Math.hypot(500, 800));
    expect(result.origin!.r).toBeLessThan(Math.hypot(500, 800) + 20);
  });

  it("底部中心收起时详情页滚动过：圆心 y 同样要加回 scrollY", () => {
    const [title] = cardLink();
    resolveNavGeometry(info({ anchor: title! }), { ...viewport, scrollY: 2000 });
    const result = back("/", { ...viewport, scrollY: 500 });
    expect(result.origin).toMatchObject({ x: 500, y: 800 - 57 + 500 });
  });

  it("回到的是同一个列表页但查询串不同（打开时带了 ?sec= 筛选，返回链接是 /）→ 仍然 collapse", () => {
    const [title] = cardLink();
    resolveNavGeometry(info({ from: "/?sec=4", anchor: title! }), viewport);
    expect(back("/").kind).toBe("collapse");
  });

  it("回到的不是打开它的那一页（另一个列表）→ 普通 pop，记录保留给对的那次", () => {
    const [title] = cardLink();
    resolveNavGeometry(info({ from: "/f/3", anchor: title! }), viewport);
    expect(back("/f/4").kind).toBe("pop");
    expect(back("/f/3").kind).toBe("collapse");
  });

  it("离开的不是那个详情页（从另一个主题返回）→ 普通 pop", () => {
    const [title] = cardLink();
    resolveNavGeometry(info({ anchor: title! }), viewport); // 首页 → /t/9
    expect(
      resolveNavGeometry(info({ from: "/t/77", to: "/", anchor: null, point: null }), viewport)
        .kind,
    ).toBe("pop");
  });

  it("新的扩散覆盖旧记录", () => {
    const [title] = cardLink();
    resolveNavGeometry(info({ from: "/f/1", anchor: title! }), viewport);
    resolveNavGeometry(info({ from: "/f/2", anchor: title!, point: { x: 50, y: 160 } }), viewport);
    expect(back("/f/1").kind).toBe("pop");
    const result = back("/f/2");
    expect(result.kind).toBe("collapse");
    expect(result.origin).toMatchObject({ x: 50, y: 160 - 57 });
  });
});
