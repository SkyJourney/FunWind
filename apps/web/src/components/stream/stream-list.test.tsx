import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamList } from "./stream-list";

type Item = { id: number; title: string };

/** 可手动触发「触底」的 IntersectionObserver 替身 */
let observers: Array<{ fire: () => void; disconnected: boolean }> = [];
class FakeObserver {
  disconnected = false;
  constructor(private cb: IntersectionObserverCallback) {
    observers.push(this);
  }
  observe() {}
  unobserve() {}
  takeRecords() {
    return [];
  }
  disconnect() {
    this.disconnected = true;
  }
  fire() {
    if (this.disconnected) return;
    this.cb([{ isIntersecting: true } as IntersectionObserverEntry], this as never);
  }
}

const page = (items: Item[], pageNo: number, hasMore: boolean) =>
  new Response(JSON.stringify({ items, hasMore, page: pageNo }), { status: 200 });

function setup(over: Partial<React.ComponentProps<typeof StreamList<Item>>> = {}) {
  return render(
    <StreamList<Item>
      endpoint="/api/stream/home?sort=new"
      fallbackHref="/?sort=new"
      startPage={1}
      hasMore
      seedIds={[1, 2]}
      renderItem={(item, enter) => (
        <article key={item.id} data-testid="appended" className={enter}>
          {item.title}
        </article>
      )}
      {...over}
    >
      <article>首屏一</article>
      <article>首屏二</article>
    </StreamList>,
  );
}

/** 触发所有仍有效的观察器（模拟哨兵进入视口） */
const scrollToBottom = () =>
  act(() => observers.filter((o) => !o.disconnected).forEach((o) => o.fire()));

beforeEach(() => {
  observers = [];
  vi.stubGlobal("IntersectionObserver", FakeObserver);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("StreamList", () => {
  it("首屏原样渲染，底部是指向下一页的真链接（无 JS 兜底，保留已有查询参数）", () => {
    setup({ startPage: 3 });
    expect(screen.getByText("首屏一")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "加载更多" })).toHaveAttribute(
      "href",
      "/?sort=new&page=4",
    );
  });

  it("触底后请求下一页并追加：带淡入类、按 id 去重（首屏已有的条目不重复）", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      page(
        [
          { id: 2, title: "重复的" },
          { id: 3, title: "新的" },
        ],
        2,
        false,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    setup();
    await scrollToBottom();

    const appended = await screen.findAllByTestId("appended");
    expect(appended.map((el) => el.textContent)).toEqual(["新的"]);
    expect(appended[0]).toHaveClass("fw-fade-in");
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/stream/home?sort=new&page=2");
    // hasMore=false → 到底文案，链接消失
    expect(await screen.findByText("没有更多了")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "加载更多" })).not.toBeInTheDocument();
  });

  it("同一时刻只有一个请求在途：触底回调连续触发也只取一次", async () => {
    let resolve!: (r: Response) => void;
    const fetchMock = vi.fn().mockReturnValue(new Promise<Response>((r) => (resolve = r)));
    vi.stubGlobal("fetch", fetchMock);
    setup();
    await scrollToBottom();
    await scrollToBottom();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => resolve(page([{ id: 9, title: "x" }], 2, true)));
    await screen.findAllByTestId("appended");
  });

  it("点击链接就地追加而不整页跳转（兜底链接同时是手动加载）", async () => {
    const fetchMock = vi.fn().mockResolvedValue(page([{ id: 5, title: "手动" }], 2, true));
    vi.stubGlobal("fetch", fetchMock);
    setup();
    await userEvent.click(screen.getByRole("link", { name: "加载更多" }));
    expect(await screen.findByText("手动")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "加载更多" })).toHaveAttribute(
      "href",
      "/?sort=new&page=3",
    );
  });

  it("失败不自动重试，提示重试；点击后重新请求并成功", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(page([{ id: 7, title: "恢复" }], 2, false));
    vi.stubGlobal("fetch", fetchMock);
    setup();
    await scrollToBottom();
    const retry = await screen.findByRole("link", { name: "加载失败，点击重试" });
    await scrollToBottom(); // 失败态下观察器已断开，不会连环请求
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await userEvent.click(retry);
    expect(await screen.findByText("恢复")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("没有更多时不渲染链接，也不创建观察器", () => {
    setup({ hasMore: false });
    expect(screen.getByText("没有更多了")).toBeInTheDocument();
    expect(observers).toHaveLength(0);
  });

  it("环境没有 IntersectionObserver：不报错，仍可手动加载", async () => {
    vi.unstubAllGlobals();
    // @ts-expect-error 模拟旧浏览器
    delete globalThis.IntersectionObserver;
    const fetchMock = vi.fn().mockResolvedValue(page([{ id: 8, title: "手动二" }], 2, false));
    vi.stubGlobal("fetch", fetchMock);
    setup();
    await userEvent.click(screen.getByRole("link", { name: "加载更多" }));
    await waitFor(() => expect(screen.getByText("手动二")).toBeInTheDocument());
  });
});

describe("StreamList · 游标模式与列表容器", () => {
  type Row = { key: string; text: string };

  function setupCursor(over: Partial<React.ComponentProps<typeof StreamList<Row>>> = {}) {
    return render(
      <StreamList<Row>
        endpoint="/api/stream/notifications?cat=interaction"
        fallbackHref="/notifications?cat=interaction"
        cursorParam="before"
        startCursor="2026-10-28 10:00:00"
        hasMore
        seedIds={["notification:1"]}
        getKey={(r) => r.key}
        as="ul"
        listClassName="space-y-2"
        renderItem={(r, enter) => (
          <li key={r.key} data-testid="row" className={enter}>
            {r.text}
          </li>
        )}
        {...over}
      >
        <li>首屏</li>
      </StreamList>,
    );
  }

  const cursorPage = (items: Row[], nextCursor: string | null) =>
    new Response(JSON.stringify({ items, hasMore: nextCursor !== null, page: 0, nextCursor }), {
      status: 200,
    });

  it("兜底链接带游标（URL 编码）；容器是 ul，li 条目合法", () => {
    const { container } = setupCursor();
    expect(screen.getByRole("link", { name: "加载更多" })).toHaveAttribute(
      "href",
      "/notifications?cat=interaction&before=2026-10-28%2010%3A00%3A00",
    );
    expect(container.querySelector("ul.space-y-2 > li")).not.toBeNull();
  });

  it("触底请求带游标；以响应里的 nextCursor 作为下一次请求，直到 null", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(cursorPage([{ key: "notification:2", text: "二" }], "C2"))
      .mockResolvedValueOnce(cursorPage([{ key: "notification:3", text: "三" }], null));
    vi.stubGlobal("fetch", fetchMock);
    setupCursor();

    await scrollToBottom();
    await screen.findByText("二");
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "/api/stream/notifications?cat=interaction&before=2026-10-28%2010%3A00%3A00",
    );

    await scrollToBottom();
    await screen.findByText("三");
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/stream/notifications?cat=interaction&before=C2");
    expect(await screen.findByText("没有更多了")).toBeInTheDocument();
  });

  it("复合键去重：同 id 不同 kind 的两条不会互相吞掉，同键重复才被丢弃", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      cursorPage(
        [
          { key: "notification:1", text: "重复的通知" },
          { key: "announcement:1", text: "同 id 的公告" },
        ],
        null,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    setupCursor();
    await scrollToBottom();
    const rows = await screen.findAllByTestId("row");
    expect(rows.map((r) => r.textContent)).toEqual(["同 id 的公告"]);
  });

  it("首屏没有更多（startCursor 为 null）：不创建观察器，直接显示到底提示", () => {
    setupCursor({ hasMore: false, startCursor: null });
    expect(screen.getByText("没有更多了")).toBeInTheDocument();
    expect(observers).toHaveLength(0);
  });
});
