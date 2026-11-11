import { cleanup, render } from "@testing-library/react";
import {
  StrictMode,
  type ReactElement,
  type ViewTransitionInstance,
  type ViewTransitionProps,
} from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMotionEngine,
  MotionPage,
  MotionProvider,
  useMotion,
  useMotionLifecycle,
  type MotionEngine,
  type MotionLifecycle,
  type MotionPageProps,
  type MotionProviderProps,
  type MotionScope,
  type MotionTarget,
} from "..";

const transitions = vi.hoisted(() => ({
  renders: [] as { props: ViewTransitionProps; identity: symbol }[],
}));

// 只替换浏览器过渡壳；组件身份与全部 hook 仍由真实 React 管理。
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    ViewTransition: function CapturedViewTransition(props: ViewTransitionProps) {
      const identity = react.useMemo(() => Symbol("ViewTransition"), []);
      transitions.renders.push({ props, identity });
      return react.createElement(react.Fragment, null, props.children);
    },
  };
});

const engines: MotionEngine[] = [];
const intent = { from: "/list", to: "/item/1", source: "link" } as const;
// 本组测试只验证实例原样委托，不访问 ReactDOM 增强的伪元素成员。
const instance = { name: "page-transition" } as ViewTransitionInstance;
const types = ["fw-push", "fw-detail"];

function setup() {
  const engine = createMotionEngine();
  engines.push(engine);
  return engine;
}

function latestTransition() {
  const transition = transitions.renders.at(-1);
  expect(transition).toBeDefined();
  return transition!;
}

function EngineProbe({ onEngine }: { onEngine: (engine: MotionEngine) => void }) {
  onEngine(useMotion());
  return null;
}

function LifecycleProbe({ draft, scope }: { draft: MotionLifecycle; scope?: MotionScope }) {
  useMotionLifecycle(draft, scope);
  return null;
}

function PageHarness({
  engine,
  onPageTransition,
  motionKey = "page-instance",
  pageKey = "reader",
  preset = "detail",
  children = <span>页面正文</span>,
}: Omit<MotionProviderProps, "children"> & Partial<MotionPageProps>) {
  return (
    <StrictMode>
      <MotionProvider engine={engine} onPageTransition={onPageTransition}>
        <MotionPage motionKey={motionKey} pageKey={pageKey} preset={preset}>
          {children}
        </MotionPage>
      </MotionProvider>
    </StrictMode>
  );
}

function complete(engine: MotionEngine, target: MotionTarget = {}) {
  const id = engine.begin(intent, target);
  engine.commit(id);
  engine.ready(id);
  engine.finish(id);
  return id;
}

// 包装真实注册器以观测每一份注销函数，同时由真实分派证明没有残留注册。
function observeRegistrations(engine: MotionEngine) {
  const entries: { scope: MotionScope; draft: MotionLifecycle; remove: () => void }[] = [];
  const register = engine.register;
  vi.spyOn(engine, "register").mockImplementation((scope, draft) => {
    const remove = vi.fn(register(scope, draft));
    entries.push({ scope, draft, remove });
    return remove;
  });
  return entries;
}

beforeEach(() => {
  transitions.renders.length = 0;
});
afterEach(() => {
  cleanup();
  engines.splice(0).forEach((engine) => engine.dispose());
  vi.restoreAllMocks();
});

describe("MotionProvider 与生命周期 hook", () => {
  it.each([
    { name: "useMotion", child: <EngineProbe onEngine={() => {}} /> },
    { name: "useMotionLifecycle", child: <LifecycleProbe draft={{}} /> },
    { name: "MotionPage", child: <MotionPage motionKey="reader">正文</MotionPage> },
  ])("$name 缺少 provider 时明确报错", ({ child }) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<StrictMode>{child}</StrictMode>)).toThrow(
      "动效接入必须位于 MotionProvider 内",
    );
  });

  it("useMotion 读取最近的 provider，替换 engine 后不持有旧实例", () => {
    const outer = setup();
    const inner = setup();
    const replacement = setup();
    const outerRead = vi.fn();
    const innerRead = vi.fn();
    const tree = (engine: MotionEngine) => (
      <StrictMode>
        <MotionProvider engine={outer}>
          <EngineProbe onEngine={outerRead} />
          <MotionProvider engine={engine}>
            <EngineProbe onEngine={innerRead} />
          </MotionProvider>
        </MotionProvider>
      </StrictMode>
    );
    const { rerender } = render(tree(inner));
    expect(outerRead).toHaveBeenLastCalledWith(outer);
    expect(innerRead).toHaveBeenLastCalledWith(inner);
    rerender(tree(replacement));
    expect(outerRead).toHaveBeenLastCalledWith(outer);
    expect(innerRead).toHaveBeenLastCalledWith(replacement);
  });

  it("StrictMode 默认全局、页面与显式 scope 对称注册，卸载后不再收到事件", () => {
    const engine = setup();
    const entries = observeRegistrations(engine);
    const global = { onReady: vi.fn() };
    const page = { onReady: vi.fn() };
    const numeric = { onReady: vi.fn() };
    const explicit = { onReady: vi.fn() };
    const scope: MotionScope = { level: "element", page: "external", element: "row" };
    const { unmount } = render(
      <StrictMode>
        <MotionProvider engine={engine}>
          <LifecycleProbe draft={global} />
          <MotionPage motionKey="instance" pageKey="reader">
            <LifecycleProbe draft={page} />
            <LifecycleProbe draft={explicit} scope={scope} />
          </MotionPage>
          <MotionPage motionKey={42}>
            <LifecycleProbe draft={numeric} />
          </MotionPage>
        </MotionProvider>
      </StrictMode>,
    );
    for (const [draft, expectedScope] of [
      [global, { level: "global" }],
      [page, { level: "page", page: "reader" }],
      [numeric, { level: "page", page: "42" }],
      [explicit, scope],
    ] as const) {
      const registrations = entries.filter((entry) => entry.draft === draft);
      expect(registrations).toHaveLength(2);
      expect(registrations.map((entry) => entry.scope)).toEqual([expectedScope, expectedScope]);
      expect(registrations[0]!.remove).toHaveBeenCalledOnce();
      expect(registrations[1]!.remove).not.toHaveBeenCalled();
    }

    const readerId = complete(engine, { page: "reader" });
    const numericId = complete(engine, { page: "42" });
    const explicitId = complete(engine, { page: "external", element: "row" });
    complete(engine, { page: "external", element: "other" });
    complete(engine);
    expect(global.onReady).toHaveBeenCalledTimes(5);
    expect(page.onReady).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: readerId }));
    expect(numeric.onReady).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: numericId }),
    );
    expect(explicit.onReady).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: explicitId }),
    );

    unmount();
    entries.forEach((entry) => expect(entry.remove).toHaveBeenCalledOnce());
    for (const target of [
      {},
      { page: "reader" },
      { page: "42" },
      { page: "external", element: "row" },
    ]) {
      complete(engine, target);
    }
    expect(global.onReady).toHaveBeenCalledTimes(5);
    for (const draft of [page, numeric, explicit]) expect(draft.onReady).toHaveBeenCalledOnce();
  });

  it("scope、draft 与 engine props 变化先注销旧注册，相同 props 不重复注册", () => {
    const engine = setup();
    const nextEngine = setup();
    const entries = observeRegistrations(engine);
    const nextEntries = observeRegistrations(nextEngine);
    const first = { onEnter: vi.fn() };
    const second = { onEnter: vi.fn() };
    const firstScope: MotionScope = { level: "page", page: "first" };
    const nextScope: MotionScope = { level: "element", page: "second", element: "row" };
    const node = document.createElement("span");
    const emit = (host: MotionEngine, page: string, element = "row") =>
      host.element("onEnter", { page, element, node });
    const tree = (host: MotionEngine, draft: MotionLifecycle, scope: MotionScope) => (
      <StrictMode>
        <MotionProvider engine={host}>
          <LifecycleProbe draft={draft} scope={scope} />
        </MotionProvider>
      </StrictMode>
    );
    const { rerender, unmount } = render(tree(engine, first, firstScope));
    expect(entries).toHaveLength(2);
    emit(engine, "first");
    expect(first.onEnter).toHaveBeenCalledOnce();
    rerender(tree(engine, first, firstScope));
    expect(entries).toHaveLength(2);

    rerender(tree(engine, second, firstScope));
    expect(entries).toHaveLength(3);
    expect(entries[1]!.remove).toHaveBeenCalledOnce();
    emit(engine, "first");
    expect(first.onEnter).toHaveBeenCalledOnce();
    expect(second.onEnter).toHaveBeenCalledOnce();

    rerender(tree(engine, second, nextScope));
    expect(entries).toHaveLength(4);
    expect(entries[2]!.remove).toHaveBeenCalledOnce();
    emit(engine, "first");
    emit(engine, "second", "other");
    expect(second.onEnter).toHaveBeenCalledOnce();
    emit(engine, "second");
    expect(second.onEnter).toHaveBeenCalledTimes(2);

    rerender(tree(nextEngine, second, nextScope));
    entries.forEach((entry) => expect(entry.remove).toHaveBeenCalledOnce());
    expect(nextEntries).toHaveLength(1);
    expect(nextEntries[0]!.remove).not.toHaveBeenCalled();
    emit(engine, "second");
    expect(second.onEnter).toHaveBeenCalledTimes(2);
    emit(nextEngine, "second");
    expect(second.onEnter).toHaveBeenCalledTimes(3);

    unmount();
    expect(nextEntries[0]!.remove).toHaveBeenCalledOnce();
    emit(nextEngine, "second");
    expect(second.onEnter).toHaveBeenCalledTimes(3);
  });

  it("同一个 MotionPage 改 pageKey 时更新默认 scope，不必依赖 motionKey 重挂载", () => {
    const engine = setup();
    const entries = observeRegistrations(engine);
    const draft = { onReady: vi.fn() };
    const tree = (pageKey?: string) => (
      <StrictMode>
        <MotionProvider engine={engine}>
          <MotionPage motionKey="fallback" pageKey={pageKey}>
            <LifecycleProbe draft={draft} />
          </MotionPage>
        </MotionProvider>
      </StrictMode>
    );
    const { rerender, unmount } = render(tree("first"));
    const identity = latestTransition().identity;
    complete(engine, { page: "first" });
    expect(draft.onReady).toHaveBeenCalledOnce();

    rerender(tree("second"));
    expect(latestTransition().identity).toBe(identity);
    expect(entries[1]!.remove).toHaveBeenCalledOnce();
    expect(entries[2]!.scope).toEqual({ level: "page", page: "second" });
    complete(engine, { page: "first" });
    expect(draft.onReady).toHaveBeenCalledOnce();
    complete(engine, { page: "second" });
    expect(draft.onReady).toHaveBeenCalledTimes(2);

    rerender(tree());
    expect(entries[2]!.remove).toHaveBeenCalledOnce();
    expect(entries[3]!.scope).toEqual({ level: "page", page: "fallback" });
    complete(engine, { page: "second" });
    expect(draft.onReady).toHaveBeenCalledTimes(2);
    complete(engine, { page: "fallback" });
    expect(draft.onReady).toHaveBeenCalledTimes(3);
    unmount();
    entries.forEach((entry) => expect(entry.remove).toHaveBeenCalledOnce());
  });
});

describe("MotionPage 的 ViewTransition 接线", () => {
  it("key 位于 VT 本体而非 div；普通内容更新保持唯一页面 wrapper 并禁用 update/default", () => {
    const engine = setup();
    const { container, rerender } = render(
      <PageHarness engine={engine} motionKey={1} preset="list" />,
    );
    const first = latestTransition();
    const child = first.props.children as ReactElement;
    expect(child.type).toBe("div");
    expect(child.key).toBeNull();
    expect(first.props).toMatchObject({
      enter: "fw-page-in",
      exit: "fw-page-out",
      update: "none",
      default: "none",
    });
    const wrapper = container.firstElementChild;
    expect(container.children).toHaveLength(1);
    expect(container.querySelectorAll("div")).toHaveLength(1);
    expect(container.querySelectorAll("[data-fw-page]")).toHaveLength(1);
    expect(wrapper).toHaveAttribute("data-motion-preset", "list");
    expect(wrapper).toHaveTextContent("页面正文");

    rerender(
      <PageHarness engine={engine} motionKey={1} preset="detail">
        <span>更新正文</span>
      </PageHarness>,
    );
    expect(latestTransition().identity).toBe(first.identity);
    expect(latestTransition().props).toMatchObject({ update: "none", default: "none" });
    expect(container.firstElementChild).toBe(wrapper);
    expect(wrapper).toHaveAttribute("data-motion-preset", "detail");
    expect(wrapper).toHaveTextContent("更新正文");

    rerender(<PageHarness engine={engine} motionKey={2} />);
    expect(latestTransition().identity).not.toBe(first.identity);
    expect((latestTransition().props.children as ReactElement).key).toBeNull();
    expect(container.firstElementChild).not.toBe(wrapper);
    expect(container.querySelectorAll("div")).toHaveLength(1);
    expect(container.querySelectorAll("[data-fw-page]")).toHaveLength(1);
  });

  it.each(["onEnter", "onExit"] as const)(
    "%s 原样委托 id、instance、types 及宿主 cleanup",
    (event) => {
      const engine = setup();
      const id = engine.begin(intent, { page: "reader" });
      engine.commit(id);
      const ready = vi.spyOn(engine, "ready");
      const finish = vi.spyOn(engine, "finish");
      const remove = vi.fn();
      const delegate = vi.fn<NonNullable<MotionProviderProps["onPageTransition"]>>(() => remove);
      render(<PageHarness engine={engine} onPageTransition={delegate} />);
      const returned = latestTransition().props[event]!(instance, types);
      expect(delegate).toHaveBeenCalledExactlyOnceWith(id, instance, types);
      expect(delegate.mock.calls[0]![1]).toBe(instance);
      expect(delegate.mock.calls[0]![2]).toBe(types);
      expect(returned).toBe(remove);
      expect(ready).not.toHaveBeenCalled();
      expect(finish).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      if (typeof returned === "function") returned();
      expect(remove).toHaveBeenCalledOnce();
      expect(engine.current).toMatchObject({ id, phase: "committed" });
    },
  );

  it.each(["onEnter", "onExit"] as const)(
    "%s 无 delegate 时 ready，返回 cleanup 才 finish",
    (event) => {
      const engine = setup();
      const onReady = vi.fn();
      const onFinish = vi.fn();
      engine.register({ level: "global" }, { onReady, onFinish });
      const id = engine.begin(intent, { page: "reader" });
      engine.commit(id);
      render(<PageHarness engine={engine} />);
      const returned = latestTransition().props[event]!(instance, types);
      expect(returned).toBeTypeOf("function");
      expect(engine.current).toMatchObject({ id, phase: "ready" });
      expect(onReady).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id }));
      expect(onFinish).not.toHaveBeenCalled();
      if (typeof returned === "function") {
        returned();
        returned();
      }
      expect(onFinish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id }));
      expect(engine.current).toBeUndefined();
    },
  );

  it.each([undefined, "other"])("target.page=%s 不匹配时不认领会话", (page) => {
    const engine = setup();
    const id = engine.begin(intent, page === undefined ? {} : { page });
    engine.commit(id);
    const delegate = vi.fn();
    const ready = vi.spyOn(engine, "ready");
    render(<PageHarness engine={engine} onPageTransition={delegate} />);
    const { props } = latestTransition();
    expect(props.onEnter!(instance, types)).toBeUndefined();
    expect(props.onExit!(instance, types)).toBeUndefined();
    expect(delegate).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
    expect(engine.current).toMatchObject({ id, phase: "committed" });
  });

  it.each([false, true])("渲染时无会话的回调不能晚到认领新会话（delegate=%s）", (delegated) => {
    const engine = setup();
    const delegate = vi.fn();
    const ready = vi.spyOn(engine, "ready");
    render(<PageHarness engine={engine} onPageTransition={delegated ? delegate : undefined} />);
    const { props } = latestTransition();
    const id = engine.begin(intent, { page: "reader" });
    engine.commit(id);
    expect(props.onEnter!(instance, types)).toBeUndefined();
    expect(props.onExit!(instance, types)).toBeUndefined();
    expect(delegate).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
    expect(engine.current).toMatchObject({ id, phase: "committed" });
  });

  it.each([false, true])("旧回调捕获旧 id，不能认领同一页面的新 id（delegate=%s）", (delegated) => {
    const engine = setup();
    const old = engine.begin(intent, { page: "reader" });
    engine.commit(old);
    const delegate = vi.fn();
    const ready = vi.spyOn(engine, "ready");
    const tree = (
      <PageHarness engine={engine} onPageTransition={delegated ? delegate : undefined} />
    );
    const { rerender } = render(tree);
    const previous = latestTransition();
    const next = engine.begin(intent, { page: "reader" });
    engine.commit(next);
    expect(next).not.toBe(old);
    expect(previous.props.onEnter!(instance, types)).toBeUndefined();
    expect(previous.props.onExit!(instance, types)).toBeUndefined();
    expect(delegate).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
    expect(engine.current).toMatchObject({ id: next, phase: "committed" });

    rerender(<PageHarness engine={engine} onPageTransition={delegated ? delegate : undefined} />);
    latestTransition().props.onEnter!(instance, types);
    if (delegated) {
      expect(delegate).toHaveBeenCalledExactlyOnceWith(next, instance, types);
      expect(ready).not.toHaveBeenCalled();
    } else {
      expect(ready).toHaveBeenCalledExactlyOnceWith(next);
      expect(engine.current).toMatchObject({ id: next, phase: "ready" });
    }
  });

  it("默认 cleanup 保留原 id，晚到收尾不结束新会话", () => {
    const engine = setup();
    const old = engine.begin(intent, { page: "reader" });
    engine.commit(old);
    render(<PageHarness engine={engine} />);
    const returned = latestTransition().props.onEnter!(instance, types);
    expect(returned).toBeTypeOf("function");
    const next = engine.begin(intent, { page: "reader" });
    engine.commit(next);
    if (typeof returned === "function") returned();
    expect(engine.current).toMatchObject({ id: next, phase: "committed" });
  });

  it.each(["onEnter", "onExit"] as const)("%s 宿主抛错只 skip 并警告，不向 React 抛出", (event) => {
    const engine = setup();
    const onSkip = vi.fn();
    engine.register({ level: "global" }, { onSkip });
    const id = engine.begin(intent, { page: "reader" });
    engine.commit(id);
    const error = new Error("宿主适配失败");
    const delegate = vi.fn(() => {
      throw error;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ready = vi.spyOn(engine, "ready");
    render(<PageHarness engine={engine} onPageTransition={delegate} />);
    expect(() => latestTransition().props[event]!(instance, types)).not.toThrow();
    expect(onSkip).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id }),
      "transition-error",
    );
    expect(warn).toHaveBeenCalledExactlyOnceWith("[motion] 页面过渡适配失败", error);
    expect(ready).not.toHaveBeenCalled();
    expect(engine.current).toBeUndefined();
  });
});

describe("SSR 与水合", () => {
  it("SSR 不读取 window、不注册客户端生命周期，导航状态变化也不改变服务端输出", () => {
    const engine = setup();
    const register = vi.spyOn(engine, "register");
    const onEngine = vi.fn();
    const draft = { onReady: vi.fn() };
    const tree = (
      <PageHarness engine={engine}>
        <EngineProbe onEngine={onEngine} />
        <LifecycleProbe draft={draft} />
        <article>服务端正文</article>
      </PageHarness>
    );
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window")!;
    const readWindow = vi.fn(() => {
      throw new Error("SSR 不应读取 window");
    });
    let first: string;
    let second: string;
    try {
      Object.defineProperty(globalThis, "window", { configurable: true, get: readWindow });
      first = renderToString(tree);
      const id = engine.begin(intent, { page: "reader" });
      engine.commit(id);
      second = renderToString(tree);
    } finally {
      Object.defineProperty(globalThis, "window", descriptor);
    }
    expect(readWindow).not.toHaveBeenCalled();
    expect(first).toBe(
      '<div data-fw-page="true" data-motion-preset="detail"><article>服务端正文</article></div>',
    );
    expect(second).toBe(first);
    expect(onEngine.mock.calls.every(([value]) => value === engine)).toBe(true);
    expect(onEngine).toHaveBeenCalledTimes(2);
    expect(register).not.toHaveBeenCalled();
    expect(draft.onReady).not.toHaveBeenCalled();
  });

  it("相同 SSR 内容在 StrictMode 水合无恢复错误，挂载后生命周期只有一份并在卸载时清理", () => {
    const engine = setup();
    const entries = observeRegistrations(engine);
    const draft = { onReady: vi.fn() };
    const tree = (
      <PageHarness engine={engine}>
        <LifecycleProbe draft={draft} />
        <article>服务端正文</article>
      </PageHarness>
    );
    const html = renderToString(tree);
    expect(entries).toHaveLength(0);
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);
    const onRecoverableError = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { unmount } = render(tree, { container, hydrate: true, onRecoverableError });
    try {
      expect(container.innerHTML).toBe(html);
      expect(container.querySelectorAll("[data-fw-page]")).toHaveLength(1);
      expect(onRecoverableError).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      complete(engine, { page: "reader" });
      expect(draft.onReady).toHaveBeenCalledOnce();
    } finally {
      unmount();
      container.remove();
    }
    expect(entries.length).toBeGreaterThan(0);
    entries.forEach((entry) => expect(entry.remove).toHaveBeenCalledOnce());
    complete(engine, { page: "reader" });
    expect(draft.onReady).toHaveBeenCalledOnce();
  });
});
