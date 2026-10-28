import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearNavKind,
  kindBetween,
  releaseNavKind,
  resetExpandRecord,
  resolveNavKind,
  setNavKind,
  type NavStartInfo,
} from "./nav-kind";

const root = () => document.documentElement;

describe("kindBetween：Tab 切换（站长反馈：同级切换原先判成 fade，几乎看不到动效）", () => {
  it("起点与终点都是 Tab 根页面且不同：往右 tab-next，往左 tab-prev，顺序 = 首页 板块 动态 搜索 发帖 消息 通知 我的 登录", () => {
    const order = [
      "/",
      "/boards",
      "/follows",
      "/search",
      "/submit",
      "/messages",
      "/notifications",
      "/me",
      "/login",
    ];
    for (let i = 0; i < order.length; i++) {
      for (let j = 0; j < order.length; j++) {
        if (i === j) continue;
        expect(kindBetween(order[i]!, order[j]!)).toBe(j > i ? "tab-next" : "tab-prev");
      }
    }
  });

  it("底部 Tab 的两种实际排列都与全局顺序一致（登录用户：首页 板块 发帖 消息 我的；访客：首页 板块 搜索 登录）", () => {
    expect(kindBetween("/boards", "/submit")).toBe("tab-next");
    expect(kindBetween("/messages", "/me")).toBe("tab-next");
    expect(kindBetween("/boards", "/search")).toBe("tab-next");
    expect(kindBetween("/login", "/search")).toBe("tab-prev");
  });

  it("同一个 Tab 不算切换（回到自身 / 仅查询串变化）→ 走层级判定（同层 fade）", () => {
    expect(kindBetween("/boards", "/boards")).toBe("fade");
  });

  it("只认 Tab 根页面本身：板块页、主题页、个人页、会话页不是 Tab 切换，仍按层级前进 / 返回", () => {
    expect(kindBetween("/boards", "/f/3")).toBe("push");
    expect(kindBetween("/f/3", "/boards")).toBe("pop");
    expect(kindBetween("/", "/t/9")).toBe("push");
    expect(kindBetween("/me", "/messages/9")).toBe("push");
    expect(kindBetween("/messages/9", "/me")).toBe("pop");
  });
});

describe("kindBetween（层级表 → 方向）", () => {
  it("目标更深 → push；更浅 → pop；同层或未知 → fade", () => {
    expect(kindBetween("/", "/t/123")).toBe("push");
    expect(kindBetween("/t/123", "/")).toBe("pop");
    expect(kindBetween("/", "/boards")).toBe("tab-next"); // 首页与 Tab 根页面之间是 Tab 切换
    expect(kindBetween("/f/3", "/u/9")).toBe("fade"); // 同层且都不是 Tab 根页面
    expect(kindBetween("/u/2", "/u/3")).toBe("fade");
    expect(kindBetween("/t/1", "/t/1")).toBe("fade");
  });

  it("板块页 → 主题页是前进（旧表里二者同为第 2 层，被判成同级淡入）", () => {
    expect(kindBetween("/f/2", "/t/9")).toBe("push");
    expect(kindBetween("/t/9", "/f/2")).toBe("pop");
    expect(kindBetween("/u/5", "/t/9")).toBe("push");
  });

  it("板块 / 用户页下的子页更深；栏目下的子页（会话）比栏目列表深一层", () => {
    expect(kindBetween("/f/2", "/f/2/new")).toBe("push");
    expect(kindBetween("/f/2/new", "/f/2")).toBe("pop");
    expect(kindBetween("/messages", "/messages/9")).toBe("push");
    expect(kindBetween("/messages/9", "/messages")).toBe("pop");
    expect(kindBetween("/me", "/messages")).toBe("tab-prev");
  });

  it("未列出的路径取 fade，不抛错", () => {
    expect(() => kindBetween("/whatever", "/unknown")).not.toThrow();
    expect(kindBetween("/settings/avatar", "/")).toBe("pop");
    expect(kindBetween("/zzz", "/")).toBe("fade");
  });
});

describe("方向属性 <html data-nav>", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearNavKind();
    delete (document as { activeViewTransition?: unknown }).activeViewTransition;
  });
  afterEach(() => {
    clearNavKind();
    vi.useRealTimers();
    delete (document as { activeViewTransition?: unknown }).activeViewTransition;
  });

  it("setNavKind 写属性，后一次覆盖前一次；clearNavKind 清除", () => {
    setNavKind("push");
    expect(root().dataset.nav).toBe("push");
    setNavKind("pop");
    expect(root().dataset.nav).toBe("pop");
    clearNavKind();
    expect(root().dataset.nav).toBeUndefined();
  });

  it("保底：导航从未提交时，15 秒后自动清除，不残留到下一次导航", () => {
    setNavKind("push");
    vi.advanceTimersByTime(14_999);
    expect(root().dataset.nav).toBe("push");
    vi.advanceTimersByTime(1);
    expect(root().dataset.nav).toBeUndefined();
  });

  it("releaseNavKind：没有进行中的过渡 → 立即清", () => {
    setNavKind("push");
    releaseNavKind();
    expect(root().dataset.nav).toBeUndefined();
  });

  it("releaseNavKind：有进行中的过渡 → 等它结束再清（动画选择器依赖该属性）", async () => {
    let finish!: () => void;
    (document as unknown as { activeViewTransition: unknown }).activeViewTransition = {
      finished: new Promise<void>((r) => (finish = r)),
    };
    setNavKind("pop");
    releaseNavKind();
    expect(root().dataset.nav).toBe("pop"); // 过渡还在播，不能提前清
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(root().dataset.nav).toBeUndefined();
  });

  it("过渡结束时若已被新导航写了别的方向，不能误清", async () => {
    let finish!: () => void;
    (document as unknown as { activeViewTransition: unknown }).activeViewTransition = {
      finished: new Promise<void>((r) => (finish = r)),
    };
    setNavKind("push");
    releaseNavKind();
    setNavKind("pop"); // 新导航
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(root().dataset.nav).toBe("pop");
  });

  it("没有方向属性时 releaseNavKind 什么也不做", () => {
    expect(() => releaseNavKind()).not.toThrow();
  });
});

describe("setNavKind 带圆心（扩散 / 收起）", () => {
  beforeEach(() => clearNavKind());
  afterEach(() => clearNavKind());

  it("expand 把触点写到 <html> 的 --vt-x / --vt-y（取整），clearNavKind 一并清掉", () => {
    setNavKind("expand", { x: 312.6, y: 140.2 });
    expect(root().dataset.nav).toBe("expand");
    expect(root().style.getPropertyValue("--vt-x")).toBe("313px");
    expect(root().style.getPropertyValue("--vt-y")).toBe("140px");
    clearNavKind();
    expect(root().style.getPropertyValue("--vt-x")).toBe("");
    expect(root().dataset.nav).toBeUndefined();
  });

  it("带终点半径时写 --vt-r（向上取整），清除时一并移除", () => {
    setNavKind("expand", { x: 10, y: 20, r: 920.2 });
    expect(root().style.getPropertyValue("--vt-r")).toBe("921px");
    clearNavKind();
    expect(root().style.getPropertyValue("--vt-r")).toBe("");
  });

  it("后一次不带圆心的导航会清掉上一次残留的圆心", () => {
    setNavKind("expand", { x: 10, y: 20 });
    setNavKind("push");
    expect(root().style.getPropertyValue("--vt-x")).toBe("");
  });
});

describe("resolveNavKind（触点扩散 / 收起）", () => {
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
    resolveNavKind(info({ from: "/t/9", to, anchor: null, point: null }), vp);
  beforeEach(() => resetExpandRecord());

  it("内容卡片里的链接点进主题页 → expand，圆心 = 点击点换算成相对页面包装盒子的坐标（y 减去 pageTop）", () => {
    const [title] = cardLink();
    const { kind, origin } = resolveNavKind(info({ anchor: title! }), viewport);
    expect(kind).toBe("expand");
    expect(origin).toMatchObject({ x: 300, y: 200 - 57 });
  });

  it("终点半径 = 触点到视口最远角的距离（+余量）：圆长到它就恰好盖满，不浪费时间在屏幕之外", () => {
    const [title] = cardLink();
    const { origin } = resolveNavKind(info({ anchor: title! }), viewport);
    expect(origin!.r).toBeGreaterThanOrEqual(farCorner);
    expect(origin!.r).toBeLessThan(farCorner + 20);
  });

  it("范围只限主题页：卡片里的板块链接（前进到 /f/）是普通 push", () => {
    const [, forum] = cardLink();
    expect(resolveNavKind(info({ to: "/f/3", anchor: forum! }), viewport)).toEqual({
      kind: "push",
      origin: null,
    });
  });

  it("不在内容卡片里的链接（如顶栏）/ 没有点击点（重试）→ 普通 push", () => {
    document.body.innerHTML = '<header><a href="/t/9">x</a></header>';
    const a = document.querySelector("a")!;
    expect(resolveNavKind(info({ anchor: a }), viewport).kind).toBe("push");
    const [title] = cardLink();
    expect(resolveNavKind(info({ anchor: title!, point: null }), viewport).kind).toBe("push");
  });

  it("随后用站内链接回到打开它的列表页 → collapse，圆心 = 当时卡片的位置，半径盖满视口", () => {
    const [title] = cardLink();
    resolveNavKind(info({ from: "/f/3?page=2", anchor: title! }), viewport);
    const result = back("/f/3?page=2");
    expect(result.kind).toBe("collapse");
    expect(result.origin).toMatchObject({ x: 300, y: 200 - 57 });
    // 列表停在顶部：卡片在视口中的 y = docY = 200，与扩散时同一个最远角
    expect(result.origin!.r).toBeGreaterThanOrEqual(farCorner);
  });

  it("收起时详情页滚动过：旧页盒子顶 = pageTop − scrollY，圆心 y 要加回 scrollY", () => {
    const [title] = cardLink();
    resolveNavKind(info({ anchor: title! }), viewport); // 列表页 docY = 200
    const result = back("/", { ...viewport, scrollY: 500 });
    expect(result.kind).toBe("collapse");
    expect(result.origin).toMatchObject({ x: 300, y: 200 - 57 + 500 });
  });

  it("记录一次性：收起之后再返回同一页是普通 pop", () => {
    const [title] = cardLink();
    resolveNavKind(info({ anchor: title! }), viewport);
    expect(back("/").kind).toBe("collapse");
    expect(back("/").kind).toBe("pop");
  });

  it("卡片在第一屏之外（点击时已滚动很深）：回到列表页停在顶部，缩向一片空白不如不收起 → 退化为 pop", () => {
    const [title] = cardLink();
    resolveNavKind(info({ anchor: title! }), { ...viewport, scrollY: 2000 }); // docY = 2200
    expect(back("/")).toEqual({ kind: "pop", origin: null });
  });

  it("回到的不是打开它的那一页（带不同查询串 / 另一个列表）→ 普通 pop，记录保留给对的那次", () => {
    const [title] = cardLink();
    resolveNavKind(info({ from: "/f/3", anchor: title! }), viewport);
    expect(back("/f/3?page=2").kind).toBe("pop");
    expect(back("/f/3").kind).toBe("collapse");
  });

  it("离开的不是那个详情页（从另一个主题返回）→ 普通 pop", () => {
    const [title] = cardLink();
    resolveNavKind(info({ anchor: title! }), viewport); // 首页 → /t/9
    expect(
      resolveNavKind(info({ from: "/t/77", to: "/", anchor: null, point: null }), viewport).kind,
    ).toBe("pop");
  });

  it("新的扩散覆盖旧记录", () => {
    const [title] = cardLink();
    resolveNavKind(info({ from: "/f/1", anchor: title! }), viewport);
    resolveNavKind(info({ from: "/f/2", anchor: title!, point: { x: 50, y: 160 } }), viewport);
    expect(back("/f/1").kind).toBe("pop");
    const result = back("/f/2");
    expect(result.kind).toBe("collapse");
    expect(result.origin).toMatchObject({ x: 50, y: 160 - 57 });
  });
});
