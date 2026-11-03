import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { PostActionsRow } from "./post-actions-row";

const link = vi.hoisted(() => vi.fn());
vi.mock("@/components/posting/post-action-link", () => ({
  PostActionLink: (props: { kind: string }) => {
    link(props);
    return <span>{props.kind}</span>;
  },
}));
const actions = {
  delete: vi.fn(),
  hide: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  disable: vi.fn(),
  restore: vi.fn(),
  report: vi.fn(),
};
const base = {
  postId: 17,
  canEdit: false,
  canHide: false,
  canReview: false,
  canDisable: false,
  canRestore: false,
  canReport: false,
  reasonRequired: false,
  actions,
};
beforeEach(() => vi.clearAllMocks());

function show(props: Partial<ComponentProps<typeof PostActionsRow>> = {}) {
  return render(<PostActionsRow {...base} {...props} />);
}

describe("帖子动作服务端展示", () => {
  it("无权限不渲染动作或额外包裹 DOM", () => {
    const { container } = show();
    expect(container).toBeEmptyDOMElement();
    expect(link).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "编辑链接与删除理由布尔 %s 原样传给 PostActionLink，Action 保持引用",
    (reasonRequired) => {
      show({ canEdit: true, reasonRequired });
      expect(screen.getByRole("link", { name: "编辑" })).toHaveAttribute("href", "/p/17/edit");
      expect(link).toHaveBeenCalledWith({
        postId: 17,
        kind: "delete",
        action: actions.delete,
        reasonRequired,
      });
    },
  );

  it("屏蔽、恢复、举报均显式传入原 Action，不暴露权限决策对象", () => {
    show({ canHide: true, canRestore: true, canReport: true });
    expect(link.mock.calls.map(([props]) => props)).toEqual([
      { postId: 17, kind: "hide", action: actions.hide },
      { postId: 17, kind: "restore", action: actions.restore },
      { postId: 17, kind: "report", action: actions.report },
    ]);
  });

  it("审核与封禁表单保持隐藏 id、必填理由、aria、样式与提交 Action", () => {
    const element = PostActionsRow({ ...base, canReview: true, canDisable: true });
    const { container } = render(element);
    expect(screen.getByLabelText("驳回理由")).toHaveAttribute("required");
    expect(screen.getByLabelText("封禁理由（作者可见）")).toHaveAttribute("maxlength", "255");
    expect(
      [...container.querySelectorAll('input[name="postId"]')].map(
        (el) => (el as HTMLInputElement).value,
      ),
    ).toEqual(["17", "17", "17"]);
    expect(screen.getAllByRole("button").map((el) => el.textContent)).toEqual([
      "通过",
      "驳回",
      "封禁",
    ]);
    // 服务端元素中的 action 必须是同一函数，不能在提取后丢失或套成客户端处理器。
    const review = element.props.children[2];
    const disable = element.props.children[3];
    expect(review.props.children[0].props.action).toBe(actions.approve);
    expect(review.props.children[1].props.action).toBe(actions.reject);
    expect(disable.props.action).toBe(actions.disable);
    expect(container.firstElementChild?.tagName).toBe("FORM");
  });
});
