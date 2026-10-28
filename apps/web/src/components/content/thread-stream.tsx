"use client";

import type { ReactNode } from "react";
import { ThreadRow } from "@/components/content/thread-row";
import { StreamList } from "@/components/stream/stream-list";
import type { ThreadListItem } from "@/lib/queries/threads";

/**
 * 主题行流（M10.7，BUG12 / Step 3b）：服务端渲染的首屏主题行 + 触底追加；板块页与用户主页「主题」tab 共用。
 * 追加项的渲染函数必须在客户端模块里定义（函数不能从服务端组件传给客户端组件），所以单独成这一层。
 * 追加页只含普通主题：置顶块只在首屏由服务端渲染，不属于流。
 */
export function ThreadStream(props: {
  /** 取数端点基础地址（带筛选参数，不含 page） */
  endpoint: string;
  /** 兜底链接基础地址（页面自身的 URL，带筛选参数，不含 page） */
  fallbackHref: string;
  startPage: number;
  hasMore: boolean;
  seedIds: readonly number[];
  /** 列表容器 className（用户主页用卡片边框容器；板块页不需要） */
  listClassName?: string;
  children: ReactNode;
}) {
  return (
    <StreamList<ThreadListItem>
      {...props}
      renderItem={(thread, enter) => <ThreadRow thread={thread} className={enter} />}
    />
  );
}
