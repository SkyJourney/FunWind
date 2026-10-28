"use client";

import { Fragment, useCallback, useEffect, useReducer, useRef, type ReactNode } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { withParam, type StreamPage } from "@/lib/stream/page";

/** 追加项的进场类（globals.css）：无延迟淡入，不错落（M10.7 站长裁定，覆盖 S4 §3.4 的「不重播」） */
const APPEND_ENTER_CLASS = "fw-fade-in";

type Key = string | number;

interface State<T> {
  items: T[];
  /** 下一次请求要带的页码 / 游标；null 表示没有更多了 */
  next: Key | null;
  status: "idle" | "loading" | "error";
}

type Action<T> =
  { type: "start" } | { type: "loaded"; items: T[]; next: Key | null } | { type: "failed" };

export interface StreamListProps<T> {
  /** 取数端点基础地址（可已带查询参数，不含游标参数），如 `/api/stream/home?sort=new` */
  endpoint: string;
  /** 兜底链接基础地址（页面自身 URL，可已带查询参数，不含游标参数）：无 JS / 失败重试 / 手动点击都走它 */
  fallbackHref: string;
  /** 页码模式：服务端首屏已渲染到的页码（下一次请求 startPage + 1）；游标模式下忽略 */
  startPage?: number;
  /** 游标模式：服务端首屏给出的下一个游标（通知）；设置后以它为首个请求参数 */
  startCursor?: string | null;
  /** 游标 / 页码在查询串里的参数名，缺省 page（通知用 before） */
  cursorParam?: string;
  hasMore: boolean;
  /**
   * 服务端首屏条目的去重键（翻页期间有新内容会让偏移错位，同一条可能再次出现）。
   * 默认键是条目的 `id`；`id` 会冲突的列表（通知与公告各有自己的 id 序列）用 `getKey` 给复合键。
   */
  seedIds: readonly Key[];
  getKey?: (item: T) => Key;
  /** 服务端首屏渲染出的条目（服务端组件，原样放进列表容器） */
  children: ReactNode;
  /** 列表容器 className：追加项与首屏项处于同一个容器，版式（grid / 分隔线）保持一致 */
  listClassName?: string;
  /** 列表容器元素：条目是 `<li>` 的列表必须用 ul，缺省 div */
  as?: "div" | "ul";
  /** 渲染一条追加项；`enterClassName` 必须挂到该项的根元素上才有淡入 */
  renderItem: (item: T, enterClassName: string) => ReactNode;
  /** 到底提示 */
  endText?: string;
}

function reducer<T>(state: State<T>, action: Action<T>): State<T> {
  switch (action.type) {
    case "start":
      return { ...state, status: "loading" };
    case "loaded":
      return { items: [...state.items, ...action.items], next: action.next, status: "idle" };
    case "failed":
      return { ...state, status: "error" };
  }
}

const defaultKey = (item: unknown): Key => (item as { id: number }).id;

/**
 * 流式追加列表（M10.7）：服务端渲染首屏 + 触底自动追加后续页。页码与游标两种分页都支持。
 *
 * - 兜底：底部始终是一个指向「下一页」的真链接——无 JS 时是普通翻页；有 JS 时点击会就地追加，
 *   失败后它就是「重试」。URL 冻结约定不变，直达某页 / 某游标时从那里起追加；
 * - 去重：按键跳过首屏与已追加过的条目；
 * - 并发：同一时刻只有一个请求在途（ref 守卫，避免触底回调重复触发）；
 * - 动效：追加项只做无延迟淡入；减少动态效果下该类被取消（globals.css）。
 */
export function StreamList<T>({
  endpoint,
  fallbackHref,
  startPage = 1,
  startCursor = null,
  cursorParam = "page",
  hasMore,
  seedIds,
  getKey = defaultKey,
  children,
  listClassName,
  as: Tag = "div",
  renderItem,
  endText = "没有更多了",
}: StreamListProps<T>) {
  const [state, dispatch] = useReducer(reducer<T>, {
    items: [],
    next: hasMore ? (startCursor ?? startPage + 1) : null,
    status: "idle",
  });
  const inFlight = useRef(false);
  const seen = useRef<Set<Key>>(new Set(seedIds));
  const sentinel = useRef<HTMLDivElement>(null);
  const aborter = useRef<AbortController | null>(null);

  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  const loadMore = useCallback(async () => {
    const { next } = stateRef.current;
    if (inFlight.current || next === null) return;
    inFlight.current = true;
    dispatch({ type: "start" });
    const controller = new AbortController();
    aborter.current = controller;
    try {
      const res = await fetch(withParam(endpoint, cursorParam, next), {
        signal: controller.signal,
        headers: { accept: "application/json" },
        credentials: "same-origin",
      });
      if (!res.ok) throw new Error(`stream ${res.status}`);
      const data = (await res.json()) as StreamPage<T>;
      const fresh = data.items.filter((item) => !seen.current.has(getKey(item)));
      for (const item of fresh) seen.current.add(getKey(item));
      // 游标分页以 nextCursor 为准；页码分页是本页页码 + 1
      const following = data.hasMore ? (data.nextCursor ?? data.page + 1) : null;
      dispatch({ type: "loaded", items: fresh, next: following });
    } catch {
      if (!controller.signal.aborted) dispatch({ type: "failed" });
    } finally {
      inFlight.current = false;
    }
  }, [endpoint, cursorParam, getKey]);

  // 触底预取：哨兵进入视口下方 600px 内就开始取下一页；失败后不自动重试（避免对故障端点连环请求），由用户点击重试
  useEffect(() => {
    const el = sentinel.current;
    if (!el || state.next === null || state.status !== "idle") return;
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore();
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [state.next, state.status, loadMore]);

  useEffect(() => () => aborter.current?.abort(), []);

  const loading = state.status === "loading";
  return (
    <>
      <Tag className={listClassName}>
        {children}
        {state.items.map((item) => (
          <Fragment key={getKey(item)}>{renderItem(item, APPEND_ENTER_CLASS)}</Fragment>
        ))}
      </Tag>
      <div ref={sentinel} className="flex items-center justify-center gap-4 py-3 text-sm">
        {state.next !== null ? (
          <Link
            href={withParam(fallbackHref, cursorParam, state.next)}
            prefetch={false}
            rel="next"
            aria-busy={loading}
            onClick={(e) => {
              e.preventDefault();
              void loadMore();
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border px-4 py-2 text-muted-foreground transition-colors hover:bg-accent"
          >
            {loading && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
            {state.status === "error" ? "加载失败，点击重试" : loading ? "加载中…" : "加载更多"}
          </Link>
        ) : (
          <span className="text-muted-foreground">{endText}</span>
        )}
      </div>
      <span role="status" aria-live="polite" className="sr-only">
        {loading ? "正在加载更多" : ""}
      </span>
    </>
  );
}
