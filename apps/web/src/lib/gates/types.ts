import type { GateCondition } from "@funwind/content";

/**
 * 门控读取侧的数据契约（docs/GATES.md）。
 * 隐藏正文只会出现在 status="open" 的 GateView 里；locked 的结果在类型上就没有内容字段。
 */

/** 判定用的门控元数据：刻意不含隐藏正文列，正文只对「开放」的门控才会去读 */
export interface GateMeta {
  id: number;
  postId: number;
  gateKey: string;
  conditions: GateCondition[];
  matchMode: "all" | "any";
  unlockCount: number;
}

/** 观众相对某个门控的事实（由 IO 层查好，判定函数是纯函数） */
export interface GateFacts {
  viewerId: number | null;
  /** 观众是该帖作者 */
  isAuthor: boolean;
  /** 观众持有 forum.moderate 或是 admin（该帖所在版块作用域） */
  isModerator: boolean;
  /** 观众已解锁的门控 id → 解锁记录 */
  unlocked: ReadonlyMap<number, { unlockedAt: string; pricePaid: number }>;
  /** 观众在该主题下有一条 visible 回帖（不含首帖） */
  hasReplied: boolean;
  /** 观众积分余额（购买提示里展示） */
  balance: number;
}

export type OpenReason = "author" | "moderator" | "unlocked" | "replied";

/** 锁定时给观众的提示（不含任何隐藏内容） */
export type GatePrompt =
  | { kind: "login" }
  | { kind: "points"; price: number; balance: number }
  | { kind: "reply" }
  | { kind: "unavailable" };

/** 判定结果（纯函数产物）；开放时的正文由服务层补上 */
export type GateDecision =
  | { open: true; reason: OpenReason; pricePaid?: number; unlockedAt?: string }
  | { open: false; prompts: GatePrompt[] };

export interface GateStats {
  /** 购买/解锁人数 */
  buyers: number;
  /** 作者累计收益 */
  income: number;
}

export type GateView =
  | {
      gateId: number;
      status: "open";
      reason: OpenReason;
      contentMd: string;
      pricePaid?: number;
      unlockedAt?: string;
      /** 仅作者视图 */
      stats?: GateStats;
    }
  | { gateId: number; status: "locked"; prompts: GatePrompt[] };
