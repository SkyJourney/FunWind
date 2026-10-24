/**
 * 主题页展示决策的纯函数单测：状态横幅、门控提示白名单、回帖标签、父帖链接、附件分组。
 * 页面渲染由 E2E（content / gates / locate / visibility）覆盖；这里逐条钉住决策本身。
 */
import { describe, expect, it } from "vitest";
import {
  attachmentDenyReason,
  gateNoticeText,
  lockedAttachmentNotice,
  parentLink,
  replyBadge,
  repliesHeading,
  splitAttachments,
  threadBanner,
} from "./thread-page";

describe("gateNoticeText：只认固定提示码", () => {
  it("白名单内的码返回文案", () => {
    expect(gateNoticeText("insufficient")).toBe("积分不足，无法解锁该内容。");
    expect(gateNoticeText("rate")).toBe("操作过于频繁，请稍后再试。");
  });

  it("未知码、空值、缺省一律返回 null（URL 里的其它内容一律忽略）", () => {
    expect(gateNoticeText(undefined)).toBeNull();
    expect(gateNoticeText("")).toBeNull();
    expect(gateNoticeText("<script>")).toBeNull();
  });

  it("原型链上的键不算提示码（不能因 Object.prototype 误命中）", () => {
    expect(gateNoticeText("constructor")).toBeNull();
    expect(gateNoticeText("__proto__")).toBeNull();
    expect(gateNoticeText("toString")).toBeNull();
  });
});

describe("threadBanner：主题状态横幅", () => {
  it("visible 不需要横幅", () => {
    expect(threadBanner("visible")).toBeNull();
  });

  it("待审：信息色，不带驳回理由", () => {
    expect(threadBanner("pending", "理由不应出现")).toEqual({
      tone: "info",
      text: "该主题正在审核中，目前只有你和版主能看到。",
    });
  });

  it("驳回：有理由才带上；空理由不带（与原页面的 && 判断一致）", () => {
    expect(threadBanner("rejected", "灌水")).toEqual({
      tone: "destructive",
      text: "该主题未通过审核，只有你和版主能看到。",
      reviewNote: "灌水",
    });
    expect(threadBanner("rejected", "")).toEqual({
      tone: "destructive",
      text: "该主题未通过审核，只有你和版主能看到。",
      reviewNote: undefined,
    });
    expect(threadBanner("rejected", null)?.reviewNote).toBeUndefined();
  });

  it("隐藏 / 删除：版主视图的灰色提示，文案区分", () => {
    expect(threadBanner("hidden")?.text).toBe("【版主视图】该主题已被隐藏，普通用户看不到。");
    expect(threadBanner("deleted")?.text).toBe("【版主视图】该主题已被删除，普通用户看不到。");
    expect(threadBanner("hidden")?.tone).toBe("muted");
  });
});

describe("replyBadge：回帖状态标签", () => {
  it("visible 不显示标签；其它四种状态各有固定文字", () => {
    expect(replyBadge("visible")).toBeNull();
    expect(replyBadge("pending")).toBe("审核中");
    expect(replyBadge("rejected")).toBe("已驳回");
    expect(replyBadge("hidden")).toBe("已隐藏");
    expect(replyBadge("deleted")).toBe("已删除");
  });
});

describe("repliesHeading：回帖列表标题", () => {
  it("单页只显示总数", () => {
    expect(repliesHeading(3, 1, 1)).toBe("回帖 3 条");
    expect(repliesHeading(0, 1, 1)).toBe("回帖 0 条");
  });

  it("多页追加页码（与原页面文字一致）", () => {
    expect(repliesHeading(45, 2, 3)).toBe("回帖 45 条 · 第 2/3 页");
  });
});

describe("parentLink：父帖链接", () => {
  const onPage = { postId: 10, threadId: 1, floor: 4, page: 2 };
  const otherPage = { postId: 11, threadId: 1, floor: 25, page: 3 };
  const first = { postId: 9, threadId: 1, floor: 1, page: 1 };

  it("父帖不可见（undefined 或 locateParents 给出的 null）→ 不渲染链接", () => {
    expect(parentLink(undefined, 1)).toBeNull();
    expect(parentLink(null, 1)).toBeNull();
  });

  it("父帖在本页内 → 页内锚点，不带页码", () => {
    expect(parentLink(onPage, 2)).toEqual({ href: "#p10", floor: 4 });
  });

  it("父帖在别的页 → 带页码的完整地址", () => {
    expect(parentLink(otherPage, 2)).toEqual({ href: "/t/1?page=3#p11", floor: 25 });
  });

  it("首帖每页都显示 → 始终用页内锚点，即便不在本页", () => {
    expect(parentLink(first, 5)).toEqual({ href: "#p9", floor: 1 });
  });

  it("别的页的第一页 → 地址不写 page 参数", () => {
    const p1 = { postId: 12, threadId: 1, floor: 3, page: 1 };
    expect(parentLink(p1, 2)).toEqual({ href: "/t/1#p12", floor: 3 });
  });
});

describe("splitAttachments：附件分组", () => {
  it("open 为可见，其余计为需解锁", () => {
    type Att = { status: "open"; id: number } | { status: "locked"; id: number };
    const list: Att[] = [
      { id: 1, status: "open" },
      { id: 2, status: "locked" },
      { id: 3, status: "open" },
    ];
    const { open, lockedCount } = splitAttachments(list);
    expect(open.map((a) => a.id)).toEqual([1, 3]);
    expect(lockedCount).toBe(1);
  });

  it("全部可见或空列表：没有锁定项", () => {
    expect(splitAttachments([{ id: 1, status: "open" }]).lockedCount).toBe(0);
    expect(splitAttachments([])).toEqual({ open: [], lockedCount: 0 });
  });
});

describe("附件提示文案", () => {
  it("游客提示登录，已登录但无权限提示无权限", () => {
    expect(attachmentDenyReason(true)).toBe("登录后下载");
    expect(attachmentDenyReason(false)).toBe("无下载权限");
  });

  it("锁定项数量写入提示", () => {
    expect(lockedAttachmentNotice(2)).toBe("🔒 本帖有 2 个附件需解锁后下载");
  });
});
