"use client";

import type { ReactNode } from "react";
import { ConversationRow } from "@/components/messages/conversation-row";
import { StreamList } from "@/components/stream/stream-list";
import type { ConversationStreamItem } from "@/lib/stream/types";

/** 私信会话列表流（M10.7 Step 3b）：服务端首屏 + 触底追加。追加项的渲染函数必须在客户端模块里定义。 */
export function ConversationStream(props: {
  endpoint: string;
  fallbackHref: string;
  startPage: number;
  hasMore: boolean;
  seedIds: readonly number[];
  children: ReactNode;
}) {
  return (
    <StreamList<ConversationStreamItem>
      {...props}
      as="ul"
      listClassName="divide-y rounded-xl border bg-card"
      renderItem={(conversation, enter) => (
        <ConversationRow conversation={conversation} className={enter} />
      )}
    />
  );
}
