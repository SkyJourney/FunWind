import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageBubble } from "./message-bubble";
import { ChatHistory } from "./chat-history";

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

const msg = (id: number, senderId = 1) => ({
  id,
  senderId,
  body: `消息${id}`,
  createdAt: "2026-10-28 10:00:00",
});
const batch = (ids: number[], hasMore: boolean) =>
  new Response(
    JSON.stringify({
      items: ids.map((id) => msg(id)),
      hasMore,
      page: 0,
      nextCursor: hasMore ? String(ids[0]) : null,
    }),
    { status: 200 },
  );

function setup(over: Partial<React.ComponentProps<typeof ChatHistory>> = {}) {
  return render(
    <ChatHistory
      convId={7}
      viewerId={1}
      oldestId={50}
      hasOlder
      scrollToBottom
      seedIds={[50, 51]}
      {...over}
    >
      <MessageBubble message={msg(50)} mine />
      <MessageBubble message={msg(51, 2)} mine={false} />
    </ChatHistory>,
  );
}

const reachTop = () => act(() => observers.filter((o) => !o.disconnected).forEach((o) => o.fire()));

let scrollTo: ReturnType<typeof vi.fn>;
/** jsdom 没有布局：文档高度按已渲染的气泡数估算（每个气泡 100px），插入更早消息后自然变高 */
const documentHeight = () => 800 + document.querySelectorAll("li").length * 100;
beforeEach(() => {
  observers = [];
  scrollTo = vi.fn();
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  vi.stubGlobal("scrollTo", scrollTo);
  Object.defineProperty(window, "scrollY", { value: 120, configurable: true });
  Object.defineProperty(document.documentElement, "scrollHeight", {
    configurable: true,
    get: documentHeight,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ChatHistory", () => {
  it("进入时滚到底部；带 before 窗口（scrollToBottom=false）时不滚", () => {
    setup();
    expect(scrollTo).toHaveBeenCalledWith(0, 1000); // 800 + 2 个气泡 × 100
    scrollTo.mockClear();
    setup({ scrollToBottom: false });
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("顶部是指向 ?before=<最旧 id> 的真链接（无 JS 兜底）", () => {
    setup();
    expect(screen.getByRole("link", { name: "查看更早的消息" })).toHaveAttribute(
      "href",
      "/messages/7?before=50",
    );
  });

  it("到顶后取更早一批并插到上方（旧→新），不重复；插入后补偿滚动位置", async () => {
    // 51 与首屏重复，应被丢弃；其余 2 条插入后文档变高 200px
    const fetchMock = vi.fn().mockResolvedValue(batch([40, 41, 51], true));
    vi.stubGlobal("fetch", fetchMock);
    setup();
    scrollTo.mockClear();

    await reachTop();
    expect(await screen.findByText("消息40")).toBeInTheDocument();
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/stream/messages/7?before=50");

    const order = screen.getAllByText(/^消息\d+$/).map((el) => el.textContent);
    expect(order).toEqual(["消息40", "消息41", "消息50", "消息51"]);
    // 补偿：原 scrollY(120) + 高度差(新增 2 个气泡 = 200)
    expect(scrollTo).toHaveBeenCalledWith(0, 320);
    // 游标推进到本批最旧一条
    expect(screen.getByRole("link", { name: "查看更早的消息" })).toHaveAttribute(
      "href",
      "/messages/7?before=40",
    );
  });

  it("最后一批：显示「没有更早的消息了」，链接消失", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(batch([1, 2], false)));
    setup();
    await reachTop();
    expect(await screen.findByText("没有更早的消息了")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "查看更早的消息" })).not.toBeInTheDocument();
  });

  it("同一时刻只有一个请求在途", async () => {
    let resolve!: (r: Response) => void;
    const fetchMock = vi.fn().mockReturnValue(new Promise<Response>((r) => (resolve = r)));
    vi.stubGlobal("fetch", fetchMock);
    setup();
    await reachTop();
    await reachTop();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => resolve(batch([49], true)));
    await screen.findByText("消息49");
  });

  it("失败不自动重试，提示重试；点击后成功", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("x", { status: 500 }))
      .mockResolvedValueOnce(batch([48], false));
    vi.stubGlobal("fetch", fetchMock);
    setup();
    await reachTop();
    const retry = await screen.findByRole("link", { name: "加载失败，点击重试" });
    await reachTop(); // 失败态下观察器已断开
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await userEvent.click(retry);
    expect(await screen.findByText("消息48")).toBeInTheDocument();
  });

  it("首屏没有更早消息：不创建观察器，也不显示任何加载控件", () => {
    setup({ hasOlder: false });
    expect(observers).toHaveLength(0);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("离开页面时还原 <html> 的 overflow-anchor", () => {
    document.documentElement.style.overflowAnchor = "auto";
    const { unmount } = setup();
    expect(document.documentElement.style.overflowAnchor).toBe("none");
    unmount();
    expect(document.documentElement.style.overflowAnchor).toBe("auto");
  });
});
