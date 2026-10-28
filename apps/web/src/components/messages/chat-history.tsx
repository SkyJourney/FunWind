"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { MessageBubble } from "@/components/messages/message-bubble";
import type { ChatMessage } from "@/lib/pm/queries";
import type { StreamPage } from "@/lib/stream/page";

interface State {
  /** 已加载的更早消息（旧→新），渲染在服务端首屏消息的上方 */
  older: ChatMessage[];
  /** 下一次请求的游标（当前已知最旧一条的 id）；null = 没有更早的了 */
  oldestId: number | null;
  status: "idle" | "loading" | "error";
}

type Action =
  | { type: "start" }
  | { type: "loaded"; items: ChatMessage[]; oldestId: number | null }
  | { type: "failed" };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "start":
      return { ...state, status: "loading" };
    case "loaded":
      return {
        older: [...action.items, ...state.older],
        oldestId: action.oldestId,
        status: "idle",
      };
    case "failed":
      return { ...state, status: "error" };
  }
}

/**
 * 聊天历史（M10.7 Step 3c）：与列表流方向相反——默认停在最新消息，**上滑**加载更早的消息。
 *
 * - 进入页面（没有 `before` 参数时）滚到底部，看到的是最新一条；
 * - 顶部哨兵进入视口就取更早一批并插到列表上方；插入后补偿滚动位置，视线中的消息不跳动。
 *   浏览器自带的滚动锚定（Safari 没有）会和手动补偿叠加，所以聊天页期间在 <html> 上关闭它；
 * - 兜底：顶部是指向 `?before=<最旧 id>` 的真链接——无 JS 时就是「查看更早的消息」，
 *   有 JS 时点击就地加载，失败后它就是「重试」；
 * - 去重按消息 id；同一时刻只有一个请求在途。
 */
export function ChatHistory({
  convId,
  viewerId,
  oldestId,
  hasOlder,
  scrollToBottom,
  seedIds,
  children,
}: {
  convId: number;
  viewerId: number;
  /** 服务端首屏最旧一条消息的 id（更早消息的游标）；首屏为空时 null */
  oldestId: number | null;
  hasOlder: boolean;
  /** 进入时是否滚到底部（带 `before` 参数查看历史窗口时不滚） */
  scrollToBottom: boolean;
  seedIds: readonly number[];
  /** 服务端渲染的最新一批气泡（<li>） */
  children: ReactNode;
}) {
  const [state, dispatch] = useReducer(reducer, {
    older: [],
    oldestId: hasOlder ? oldestId : null,
    status: "idle",
  });
  const inFlight = useRef(false);
  const seen = useRef<Set<number>>(new Set(seedIds));
  const topRef = useRef<HTMLDivElement>(null);
  const aborter = useRef<AbortController | null>(null);
  /** 插入前记录的滚动现场，布局提交后据此补偿 */
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  // 进入页面：滚到底部。必须是布局副作用——先于下面的观察器订阅，否则顶部哨兵在 scrollY=0 时可见，
  // 会立刻把更早的消息加载出来。
  useLayoutEffect(() => {
    if (scrollToBottom) window.scrollTo(0, document.documentElement.scrollHeight);
  }, [scrollToBottom]);

  // 手动补偿滚动期间关闭浏览器的滚动锚定，离开页面时还原
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.style.overflowAnchor;
    root.style.overflowAnchor = "none";
    return () => {
      root.style.overflowAnchor = previous;
    };
  }, []);

  // 更早的消息插入到上方后，把滚动位置下移同样的高度差，视线中的消息保持不动
  useLayoutEffect(() => {
    const saved = anchor.current;
    if (!saved) return;
    anchor.current = null;
    window.scrollTo(0, saved.top + (document.documentElement.scrollHeight - saved.height));
  }, [state.older]);

  const loadOlder = useCallback(async () => {
    const { oldestId: cursor } = stateRef.current;
    if (inFlight.current || cursor === null) return;
    inFlight.current = true;
    dispatch({ type: "start" });
    const controller = new AbortController();
    aborter.current = controller;
    try {
      const res = await fetch(`/api/stream/messages/${convId}?before=${cursor}`, {
        signal: controller.signal,
        headers: { accept: "application/json" },
        credentials: "same-origin",
      });
      if (!res.ok) throw new Error(`chat ${res.status}`);
      const data = (await res.json()) as StreamPage<ChatMessage>;
      const fresh = data.items.filter((m) => !seen.current.has(m.id));
      for (const m of fresh) seen.current.add(m.id);
      anchor.current = {
        height: document.documentElement.scrollHeight,
        top: window.scrollY,
      };
      dispatch({
        type: "loaded",
        items: fresh,
        oldestId: data.hasMore && data.nextCursor ? Number(data.nextCursor) : null,
      });
    } catch {
      if (!controller.signal.aborted) dispatch({ type: "failed" });
    } finally {
      inFlight.current = false;
    }
  }, [convId]);

  // 顶部预取：哨兵进入视口上方 400px 内就取更早一批；失败后不自动重试，由用户点击重试
  useEffect(() => {
    const el = topRef.current;
    if (!el || state.oldestId === null || state.status !== "idle") return;
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadOlder();
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [state.oldestId, state.status, loadOlder]);

  useEffect(() => () => aborter.current?.abort(), []);

  const loading = state.status === "loading";
  return (
    <>
      <div ref={topRef} className="flex justify-center pb-3 text-xs">
        {state.oldestId !== null ? (
          <Link
            href={`/messages/${convId}?before=${state.oldestId}`}
            prefetch={false}
            rel="prev"
            aria-busy={loading}
            onClick={(e) => {
              e.preventDefault();
              void loadOlder();
            }}
            className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-muted-foreground transition-colors hover:bg-accent"
          >
            {loading && <Loader2 className="size-3 animate-spin" aria-hidden />}
            {state.status === "error"
              ? "加载失败，点击重试"
              : loading
                ? "加载中…"
                : "查看更早的消息"}
          </Link>
        ) : (
          state.older.length > 0 && <span className="text-muted-foreground">没有更早的消息了</span>
        )}
      </div>
      <ul className="space-y-2.5">
        {state.older.map((m) => (
          <Fragment key={m.id}>
            <MessageBubble message={m} mine={m.senderId === viewerId} />
          </Fragment>
        ))}
        {children}
      </ul>
      <span role="status" aria-live="polite" className="sr-only">
        {loading ? "正在加载更早的消息" : ""}
      </span>
    </>
  );
}
