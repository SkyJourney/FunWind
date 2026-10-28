"use client";

import type { ReactNode } from "react";
import { UserReplyRow } from "@/components/content/user-reply-row";
import { StreamList } from "@/components/stream/stream-list";
import type { UserReplyStreamItem } from "@/lib/stream/types";

/**
 * 用户回复流（M10.7 Step 3b）：用户主页「回复」tab 的服务端首屏 + 触底追加。
 * 追加项的渲染函数必须在客户端模块里定义，所以单独成这一层。
 */
export function UserReplyStream(props: {
  endpoint: string;
  fallbackHref: string;
  startPage: number;
  hasMore: boolean;
  seedIds: readonly number[];
  listClassName?: string;
  children: ReactNode;
}) {
  return (
    <StreamList<UserReplyStreamItem>
      {...props}
      renderItem={(reply, enter) => <UserReplyRow reply={reply} className={enter} />}
    />
  );
}
