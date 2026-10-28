import { describe, expect, it } from "vitest";
import type { FeedItem } from "./queries";
import { toNotificationRow } from "./row";

const base: FeedItem = {
  kind: "notification",
  id: 7,
  category: "interaction",
  type: "post.replied",
  actorId: 3,
  actorName: "小明",
  read: false,
  createdAt: "2026-10-28 10:00:00",
  data: { title: "某主题" },
};

describe("toNotificationRow", () => {
  it("通知与公告用 kind 作前缀，即使 id 相同键也不冲突", () => {
    const n = toNotificationRow(base);
    const a = toNotificationRow({ ...base, kind: "announcement", id: 7, title: "停机维护" });
    expect(n.key).toBe("notification:7");
    expect(a.key).toBe("announcement:7");
    expect(a.label).toBe("公告：停机维护");
    expect(a.categoryLabel).toBe("公告");
  });

  it("未知类型回落到类型键与分类名，不抛错", () => {
    const row = toNotificationRow({ ...base, type: "no.such.type" });
    expect(row.label).toBe("no.such.type");
    expect(row.categoryLabel).toBe("interaction");
  });

  it("私信通知带会话 id；其它通知为 null", () => {
    expect(
      toNotificationRow({ ...base, targetType: "conversation", targetId: 42 }).conversationId,
    ).toBe(42);
    expect(toNotificationRow({ ...base, targetType: "post", targetId: 42 }).conversationId).toBe(
      null,
    );
  });

  it("聚合条数：有 groupKey 且 count>1 才显示", () => {
    const grouped = { ...base, groupKey: "g", data: { count: 3 } };
    expect(toNotificationRow(grouped).groupCount).toBe(3);
    expect(toNotificationRow({ ...grouped, data: { count: 1 } }).groupCount).toBe(null);
    expect(toNotificationRow({ ...grouped, groupKey: null }).groupCount).toBe(null);
  });

  it("只有公告带正文；通知的原始 data 不出现在行数据里", () => {
    const row = toNotificationRow({ ...base, data: { secret: "不应下发" } });
    expect(row.bodyMd).toBe(null);
    expect(JSON.stringify(row)).not.toContain("不应下发");
    expect(toNotificationRow({ ...base, kind: "announcement", bodyMd: "正文" }).bodyMd).toBe(
      "正文",
    );
  });
});
