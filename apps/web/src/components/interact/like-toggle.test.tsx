import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LikeToggle } from "./like-toggle";

const likeAction = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("@/app/actions/interact", () => ({ likeAction }));
vi.mock("sonner", () => ({ toast }));

const setup = (over: Partial<React.ComponentProps<typeof LikeToggle>> = {}) =>
  render(<LikeToggle postId={900101} liked={false} likeCount={0} back="/t/9" canLike {...over} />);
const button = () => screen.getByRole("button");

/** 一个可手动完成的 Server Action（模拟服务端往返） */
function deferredAction() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  likeAction.mockImplementationOnce(
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
  likeAction.mockReset();
  likeAction.mockResolvedValue(undefined);
  toast.error.mockReset();
});

describe("LikeToggle · 结构与无 JS 回退", () => {
  it("保留 form + 隐藏域 + data-testid（无 JS 时就是普通表单提交给 Server Action）", () => {
    const { container } = setup();
    const form = container.querySelector("form")!;
    expect(form).toHaveAttribute("data-testid", "like-900101");
    expect(form.querySelector('input[name="postId"]')).toHaveValue("900101");
    expect(form.querySelector('input[name="back"]')).toHaveValue("/t/9");
    expect(button()).toHaveAttribute("type", "submit");
  });

  it("0 赞显示「赞」，有赞显示数字；初始渲染不带任何动画类", () => {
    const { container, unmount } = setup();
    expect(button()).toHaveTextContent("赞");
    expect(container.querySelector(".fw-pop, .fw-float-up, [class*='fw-roll-']")).toBeNull();
    unmount();
    setup({ likeCount: 12, liked: true });
    expect(button()).toHaveTextContent("12");
    expect(button()).toHaveAttribute("aria-pressed", "true");
  });

  it("游客：按钮禁用，提交不会调用 Server Action", async () => {
    setup({ canLike: false });
    expect(button()).toBeDisabled();
    await userEvent.click(button());
    expect(likeAction).not.toHaveBeenCalled();
  });
});

describe("LikeToggle · 乐观更新", () => {
  it("点赞：服务端还没返回就立即 +1 并变为已点赞；Server Action 带着 postId / back 被调用", async () => {
    const d = deferredAction();
    setup({ likeCount: 3 });
    await userEvent.click(button());
    expect(button()).toHaveTextContent("4"); // 乐观：不等服务端
    expect(button()).toHaveAttribute("aria-pressed", "true");
    expect(button()).toHaveAttribute("aria-busy", "true");
    const fd = likeAction.mock.calls[0]![0] as FormData;
    expect(fd.get("postId")).toBe("900101");
    expect(fd.get("back")).toBe("/t/9");
    await d.resolve();
  });

  it("取消点赞：立即 −1；只有 1 个赞时取消后回到「赞」", async () => {
    const d = deferredAction();
    setup({ liked: true, likeCount: 1 });
    await userEvent.click(button());
    expect(button()).toHaveTextContent("赞");
    expect(button()).toHaveAttribute("aria-pressed", "false");
    await d.resolve();
  });

  it("进行中忽略重复点击（不会产生多次切换）", async () => {
    const d = deferredAction();
    setup({ likeCount: 0 });
    await userEvent.click(button());
    await userEvent.click(button());
    await userEvent.click(button());
    expect(likeAction).toHaveBeenCalledTimes(1);
    expect(button()).toHaveTextContent("1");
    await d.resolve();
  });

  it("失败：toast 提示，乐观值回滚到服务端原值", async () => {
    const d = deferredAction();
    setup({ likeCount: 5 });
    await userEvent.click(button());
    expect(button()).toHaveTextContent("6");
    await d.reject();
    expect(toast.error).toHaveBeenCalledWith("操作失败，请重试");
    expect(button()).toHaveTextContent("5");
    expect(button()).toHaveAttribute("aria-pressed", "false");
  });
});

describe("LikeToggle · 微交互动效钩子（具体动画见 globals.css，reduce 下取消）", () => {
  it("点赞：图标弹跳、数字上滚（旧值滚出）、飘出 +1", async () => {
    const d = deferredAction();
    const { container } = setup({ likeCount: 0 });
    await userEvent.click(button());
    expect(container.querySelector(".fw-pop")).not.toBeNull();
    expect(container.querySelector(".fw-roll-in-up")).toHaveTextContent("1");
    const out = container.querySelector(".fw-roll-out-up")!;
    expect(out).toHaveTextContent("赞");
    expect(out).toHaveAttribute("aria-hidden", "true"); // 滚出的旧值不被读屏重复朗读
    expect(container.querySelector(".fw-float-up")).toHaveTextContent("+1");
    await d.resolve();
  });

  it("取消点赞：图标弹跳、数字下滚，不飘 +1", async () => {
    const d = deferredAction();
    const { container } = setup({ liked: true, likeCount: 4 });
    await userEvent.click(button());
    expect(container.querySelector(".fw-roll-in-down")).toHaveTextContent("3");
    expect(container.querySelector(".fw-roll-out-down")).toHaveTextContent("4");
    expect(container.querySelector(".fw-float-up")).toBeNull();
    await d.resolve();
  });
});
