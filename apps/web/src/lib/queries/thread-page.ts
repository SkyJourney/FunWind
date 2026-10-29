/**
 * 主题页的展示决策（纯函数，不做任何 I/O）：状态横幅、门控提示、回帖标签与父帖链接、附件分组与提示文案。
 * 页面（app/t/[tid]/page.tsx）只负责把这些结果渲染成 JSX；决策放在这里，便于逐条单测。
 * 注意：这里只接收已经过权限过滤的数据，本模块不做任何可见性判断。
 */
import type { ContentState } from "@funwind/db";
import { postPath } from "./locate-post";

/** 购买失败的固定提示码（?gate=…）→ 文案。只认这几个码，URL 里的其它内容一律忽略 */
export const GATE_NOTICES: Record<string, string> = {
  insufficient: "积分不足，无法解锁该内容。",
  own_content: "你是该内容的作者或版主，无需购买。",
  unavailable: "该内容暂不可购买。",
  price_changed: "价格已变化，请确认新价格后重试。",
  already_open: "你已经可以查看这段内容，无需购买。",
  rate: "操作过于频繁，请稍后再试。",
};

/** 门控提示码 → 文案；未知码（含原型链上的键）一律返回 null */
export function gateNoticeText(code: string | undefined): string | null {
  return code !== undefined && Object.hasOwn(GATE_NOTICES, code) ? GATE_NOTICES[code]! : null;
}

/** 主题状态横幅：tone 决定配色，reviewNote 只在驳回且有理由时出现 */
export interface ThreadBanner {
  tone: "info" | "destructive" | "muted";
  text: string;
  reviewNote?: string;
}

/** 主题的状态横幅。visible 不需要横幅，返回 null */
export function threadBanner(state: ContentState, reviewNote?: string | null): ThreadBanner | null {
  switch (state) {
    case "pending":
      return { tone: "info", text: "该主题正在审核中，目前只有你和版主能看到。" };
    case "rejected":
      return {
        tone: "destructive",
        text: "该主题未通过审核，只有你和版主能看到。",
        reviewNote: reviewNote ? reviewNote : undefined,
      };
    case "disabled":
      return {
        tone: "destructive",
        text: "该内容已被管理员封禁：不可编辑、不可重新提交审核。",
        reviewNote: reviewNote ? reviewNote : undefined,
      };
    case "hidden":
      return { tone: "muted", text: "【版主视图】该主题已被隐藏，普通用户看不到。" };
    case "deleted":
      return { tone: "muted", text: "【版主视图】该主题已被删除，普通用户看不到。" };
    default:
      return null;
  }
}

/** 回帖的状态标签；visible 不显示标签 */
export function replyBadge(state: ContentState): string | null {
  switch (state) {
    case "pending":
      return "审核中";
    case "rejected":
      return "已驳回";
    case "disabled":
      return "已封禁";
    case "hidden":
      return "已隐藏";
    case "deleted":
      return "已删除";
    default:
      return null;
  }
}

/** 回帖列表的标题：「回帖 N 条」，多页时追加「· 第 p/共 n 页」 */
export function repliesHeading(total: number, page: number, totalPages: number): string {
  return `回帖 ${total} 条${totalPages > 1 ? ` · 第 ${page}/${totalPages} 页` : ""}`;
}

/** 父帖（被引用的回帖）的定位结果：页面用 locateParents 取得，不可见的父帖为 null（映射里缺失则为 undefined） */
export interface ParentLocation {
  postId: number;
  threadId: number;
  floor: number;
  page: number;
}

/**
 * 「↩ 回复 #N」的链接：父帖在本页内（或是首帖，每页都固定显示）用页内锚点；在别的页则带页码。
 * 父帖不可见（null / undefined）时不渲染链接，也不泄露它的楼层。
 */
export function parentLink(
  parent: ParentLocation | null | undefined,
  currentPage: number,
): { href: string; floor: number } | null {
  if (!parent) return null;
  const href =
    parent.page === currentPage || parent.floor === 1 ? `#p${parent.postId}` : postPath(parent);
  return { href, floor: parent.floor };
}

/**
 * 把一帖的附件分为「可见」与「需解锁」两组。
 * 锁定项只计数，不带文件名 / 存储键（那些数据在 attachments 层就不会下发）。
 */
export function splitAttachments<T extends { status: string }>(
  list: readonly T[],
): { open: Extract<T, { status: "open" }>[]; lockedCount: number } {
  const open = list.filter((a): a is Extract<T, { status: "open" }> => a.status === "open");
  return { open, lockedCount: list.length - open.length };
}

/** 无法下载可见附件时的说明文字：游客提示登录，已登录但无权限提示无权限 */
export function attachmentDenyReason(isGuest: boolean): string {
  return isGuest ? "登录后下载" : "无下载权限";
}

/** 本帖有需解锁附件时的提示 */
export function lockedAttachmentNotice(count: number): string {
  return `🔒 本帖有 ${count} 个附件需解锁后下载`;
}
