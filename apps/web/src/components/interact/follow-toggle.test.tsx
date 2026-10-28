import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FollowToggle } from "./follow-toggle";

const followAction = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("@/app/actions/interact", () => ({ followAction }));
vi.mock("sonner", () => ({ toast }));

const setup = (over: Partial<React.ComponentProps<typeof FollowToggle>> = {}) =>
  render(<FollowToggle targetType="user" targetId={7} following={false} back="/u/7" {...over} />);
const button = () => screen.getByRole("button");

function deferredAction() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  followAction.mockImplementationOnce(
    () =>
      new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      }),
  );
  return {
    resolve: () => act(async () => resolve()),
    reject: () => act(async () => reject(new Error("boom"))),
  };
}

beforeEach(() => {
  followAction.mockReset();
  followAction.mockResolvedValue(undefined);
  toast.error.mockReset();
});

describe("FollowToggle", () => {
  it("保留 form + 隐藏域（无 JS 回退）；文案：用户「关注」/ 版块「加入关注」/ 已关注「已关注」", () => {
    const { container, unmount } = setup();
    const form = container.querySelector("form")!;
    expect(form.querySelector('input[name="targetType"]')).toHaveValue("user");
    expect(form.querySelector('input[name="targetId"]')).toHaveValue("7");
    expect(form.querySelector('input[name="back"]')).toHaveValue("/u/7");
    expect(button()).toHaveTextContent("关注");
    unmount();
    setup({ targetType: "forum" });
    expect(button()).toHaveTextContent("加入关注");
  });

  it("初始渲染没有动画类；已关注显示对勾与「已关注」", () => {
    const { container } = setup({ following: true });
    expect(container.querySelector(".fw-pop, .fw-fade-in")).toBeNull();
    expect(button()).toHaveTextContent("已关注");
    expect(button()).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("点击立即切换为「已关注」（不等服务端），按钮弹跳、文案淡入；Action 带着目标信息被调用", async () => {
    const d = deferredAction();
    const { container } = setup();
    await userEvent.click(button());
    expect(button()).toHaveTextContent("已关注");
    expect(button()).toHaveAttribute("aria-busy", "true");
    expect(container.querySelector(".fw-pop")).not.toBeNull();
    expect(container.querySelector(".fw-fade-in")).toHaveTextContent("已关注");
    const fd = followAction.mock.calls[0]![0] as FormData;
    expect(fd.get("targetType")).toBe("user");
    expect(fd.get("targetId")).toBe("7");
    await d.resolve();
  });

  it("已关注再点：立即回到「关注」", async () => {
    const d = deferredAction();
    setup({ following: true });
    await userEvent.click(button());
    expect(button()).toHaveTextContent("关注");
    expect(button()).not.toHaveTextContent("已关注");
    await d.resolve();
  });

  it("进行中忽略重复点击", async () => {
    const d = deferredAction();
    setup();
    await userEvent.click(button());
    await userEvent.click(button());
    expect(followAction).toHaveBeenCalledTimes(1);
    await d.resolve();
  });

  it("失败：toast 提示，状态回滚到服务端原值", async () => {
    const d = deferredAction();
    setup();
    await userEvent.click(button());
    expect(button()).toHaveTextContent("已关注");
    await d.reject();
    expect(toast.error).toHaveBeenCalledWith("操作失败，请重试");
    expect(button()).toHaveTextContent("关注");
    expect(button()).toHaveAttribute("aria-pressed", "false");
  });
});
