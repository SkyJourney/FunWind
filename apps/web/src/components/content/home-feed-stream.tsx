"use client";

import type { ReactNode } from "react";
import { FeedCard } from "@/components/content/feed-card";
import { StreamList } from "@/components/stream/stream-list";
import type { HomeStreamItem } from "@/lib/stream/types";

/**
 * 首页内容流（M10.7，BUG3）：服务端渲染的首屏卡片 + 触底追加。
 * 追加项的渲染函数必须在客户端模块里定义（函数不能从服务端组件传给客户端组件），所以单独成这一层。
 */
export function HomeFeedStream(props: {
  /** 取数端点基础地址（带 sec / sort，不含 page） */
  endpoint: string;
  /** 兜底链接基础地址（首页自身的 URL，带 sec / sort，不含 page） */
  fallbackHref: string;
  startPage: number;
  hasMore: boolean;
  seedIds: readonly number[];
  /** 列表容器 className，缺省为首页的 grid；关注动态页用 space-y-3 */
  listClassName?: string;
  children: ReactNode;
}) {
  const { listClassName = "grid gap-2.5", ...rest } = props;
  return (
    <StreamList<HomeStreamItem>
      {...rest}
      listClassName={listClassName}
      renderItem={(item, enter) => (
        <FeedCard item={item} forumName={item.forumName ?? undefined} className={enter} />
      )}
    />
  );
}
