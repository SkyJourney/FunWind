"use client";

import type { ReactNode } from "react";
import { StreamList } from "@/components/stream/stream-list";
import type { LedgerItem } from "@/lib/points/ledger";
import { LedgerRow } from "./ledger-row";

/** 积分流水流（M10.7 Step 3b）：服务端首屏 + 触底追加。追加项的渲染函数必须在客户端模块里定义。 */
export function LedgerStream(props: {
  endpoint: string;
  fallbackHref: string;
  startPage: number;
  hasMore: boolean;
  seedIds: readonly number[];
  children: ReactNode;
}) {
  return (
    <StreamList<LedgerItem>
      {...props}
      as="ul"
      listClassName="divide-y"
      renderItem={(item, enter) => <LedgerRow item={item} className={enter} />}
    />
  );
}
