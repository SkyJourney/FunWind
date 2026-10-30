import { describe, expect, it } from "vitest";
import { CATEGORY_LABELS, NOTIFICATION_TYPE_SPECS, renderNotification, typeSpec } from "./render";

/** 渲染模板与类型目录（纯函数；M8 审查整改后补齐覆盖） */
describe("通知渲染目录", () => {
  it("34 个类型目录齐全且键唯一（互动6+私信1+审核16+账号10；M9.6 增注销与申诉通知）", () => {
    expect(NOTIFICATION_TYPE_SPECS.length).toBe(34);
    expect(new Set(NOTIFICATION_TYPE_SPECS.map((s) => s.key)).size).toBe(34);
  });

  it("typeSpec 查找与未知键", () => {
    expect(typeSpec("post.liked")?.category).toBe("interaction");
    expect(typeSpec("made.up")).toBeNull();
  });

  it("占位符替换：actor/count/数值；缺失占位符保留原样", () => {
    expect(renderNotification("post.replied", { title: "开楼" }, "demo_team")?.label).toBe(
      "demo_team 回复了你的主题《开楼》",
    );
    expect(renderNotification("gate.sold", { price: 7 }, "demo_alice")?.label).toBe(
      "demo_alice 购买了你的付费内容（+7）",
    );
    expect(renderNotification("points.adjusted", { delta: "+7" })?.label).toBe(
      "管理员调整了你的积分（+7）",
    );
    expect(renderNotification("post.reply_to", { floor: 3 }, "u")?.label).toBe(
      "u 回复了你的第 3 楼",
    );
    // 缺 data：占位符保留（便于发现数据缺口）
    expect(renderNotification("post.replied", null)?.label).toContain("{title}");
    expect(renderNotification("no.such.type", {})).toBeNull();
  });

  it("角色通知呈现公开范围与期限，不包含管理理由", () => {
    expect(
      renderNotification("account.role_changed", {
        roleName: "字幕制作组",
        actionText: "已授予",
        scopeLabel: "板块范围",
        validity: "有效至 2099-01-01 00:00:00",
      })?.label,
    ).toBe("你的角色「字幕制作组」已授予（板块范围，有效至 2099-01-01 00:00:00）");
  });

  it("分类标签齐全", () => {
    expect(CATEGORY_LABELS.interaction).toBe("互动");
    expect(CATEGORY_LABELS.moderation).toBe("审核与管理");
  });
});
