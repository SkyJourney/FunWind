"use client";

import { Fragment, useCallback, useEffect, useReducer, useRef, type ReactNode } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { withPageParam, type StreamPage } from "@/lib/stream/page";

/** 追加项的进场类（globals.css）：无延迟淡入，不错落（M10.7 站长裁定，覆盖 S4 §3.4 的「不重播」） */
const APPEND_ENTER_CLASS = "fw-fade-in";

interface State<T> {
  items: T[];
  /** 已加载到的页码（含服务端首屏） */
  page: number;
  hasMore: boolean;
  status: "idle" | "loading" | "error";
}

type Action<T> =
  | { type: "start" }
  | { type: "loaded"; items: T[]; page: number; hasMore: boolean }
  | { type: "failed" };

export interface StreamListProps<T extends { id: number }> {
  /** 取数端点基础地址（可已带查询参数，不含 page），如 `/api/stream/home?sort=new` */
  endpoint: string;
  /** 兜底链接基础地址（页面自身 URL，可已带查询参数，不含 page）：无 JS / 失败重试 / 手动点击都走它 */
  fallbackHref: string;
  /** 服务端首屏已渲染到的页码 */
  startPage: number;
  hasMore: boolean;
  /** 服务端首屏条目 id，追加时据此去重（翻页期间有新帖会让偏移错位，同一条可能再次出现） */
  seedIds: readonly number[];
  /** 服务端首屏渲染出的条目（服务端组件，原样放进列表容器） */
  children: ReactNode;
  /** 列表容器 className：追加项与首屏项处于同一个容器，版式（grid / 分隔线）保持一致 */
  listClassName?: string;
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
      return {
        items: [...state.items, ...action.items],
        page: action.page,
        hasMore: action.hasMore,
        status: "idle",
      };
    case "failed":
      return { ...state, status: "error" };
  }
}

/**
 * 流式追加列表（M10.7，BUG3/BUG12）：服务端渲染首屏 + 触底自动追加后续页。
 *
 * - 兜底：底部始终是一个指向 `?page=N+1` 的真链接——无 JS 时是普通翻页；有 JS 时点击会就地追加，
 *   失败后它就是「重试」。URL（`?page=`）冻结约定不变，直达 `?page=N` 从 N 页起追加；
 * - 去重：按 id 跳过首屏与已追加过的条目；
 * - 并发：同一时刻只有一个请求在途（ref 守卫，避免触底回调重复触发）；
 * - 动效：追加项只做无延迟淡入；减少动态效果下该类被取消（globals.css）。
 */
export function StreamList<T extends { id: number }>({
  endpoint,
  fallbackHref,
  startPage,
  hasMore,
  seedIds,
  children,
  listClassName,
  renderItem,
  endText = "没有更多了",
}: StreamListProps<T>) {
  const [state, dispatch] = useReducer(reducer<T>, {
    items: [],
    page: startPage,
    hasMore,
    status: "idle",
  });
  const inFlight = useRef(false);
  const seen = useRef<Set<number>>(new Set(seedIds));
  const sentinel = useRef<HTMLDivElement>(null);
  const aborter = useRef<AbortController | null>(null);

  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  const loadMore = useCallback(async () => {
    const current = stateRef.current;
    if (inFlight.current || !current.hasMore) return;
    inFlight.current = true;
    dispatch({ type: "start" });
    const controller = new AbortController();
    aborter.current = controller;
    try {
      const res = await fetch(withPageParam(endpoint, current.page + 1), {
        signal: controller.signal,
        headers: { accept: "application/json" },
        credentials: "same-origin",
      });
      if (!res.ok) throw new Error(`stream ${res.status}`);
      const data = (await res.json()) as StreamPage<T>;
      const fresh = data.items.filter((item) => !seen.current.has(item.id));
      for (const item of fresh) seen.current.add(item.id);
      dispatch({ type: "loaded", items: fresh, page: data.page, hasMore: data.hasMore });
    } catch {
      if (!controller.signal.aborted) dispatch({ type: "failed" });
    } finally {
      inFlight.current = false;
    }
  }, [endpoint]);

  // 触底预取：哨兵进入视口下方 600px 内就开始取下一页；失败后不自动重试（避免对故障端点连环请求），由用户点击重试
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !state.hasMore || state.status !== "idle") return;
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore();
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [state.hasMore, state.status, state.page, loadMore]);

  useEffect(() => () => aborter.current?.abort(), []);

  const loading = state.status === "loading";
  return (
    <>
      <div className={listClassName}>
        {children}
        {state.items.map((item) => (
          <Fragment key={item.id}>{renderItem(item, APPEND_ENTER_CLASS)}</Fragment>
        ))}
      </div>
      <div ref={sentinel} className="flex items-center justify-center gap-4 py-3 text-sm">
        {state.hasMore ? (
          <Link
            href={withPageParam(fallbackHref, state.page + 1)}
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
