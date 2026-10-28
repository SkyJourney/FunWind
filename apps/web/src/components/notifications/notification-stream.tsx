"use client";

import type { ReactNode } from "react";
import { NotificationRow } from "@/components/notifications/notification-row";
import { StreamList } from "@/components/stream/stream-list";
import type { NotificationRowData } from "@/lib/notifications/row";

const rowKey = (row: NotificationRowData) => row.key;

/**
 * 通知流（M10.7 Step 3b）：服务端首屏 + 触底追加。通知是游标分页（`before=<createdAt>`），
 * 且通知与公告的 id 序列相互独立，所以用复合键去重。追加项的渲染函数必须在客户端模块里定义。
 */
export function NotificationStream(props: {
  endpoint: string;
  fallbackHref: string;
  /** 首屏给出的下一个游标；无更多时为 null */
  startCursor: string | null;
  seedKeys: readonly string[];
  /** 无 JS 回退时「已读」表单重定向的页面（带分类参数） */
  backHref: string;
  children: ReactNode;
}) {
  const { seedKeys, backHref, startCursor, ...rest } = props;
  return (
    <StreamList<NotificationRowData>
      {...rest}
      as="ul"
      listClassName="space-y-2"
      cursorParam="before"
      startCursor={startCursor}
      hasMore={startCursor !== null}
      seedIds={seedKeys}
      getKey={rowKey}
      renderItem={(row, enter) => (
        <NotificationRow row={row} backHref={backHref} className={enter} />
      )}
    />
  );
}
