import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PostActionLink } from "./post-action-link";

describe("PostActionLink", () => {
  it("keeps the legacy link and opens an accessible dialog with a required reason", async () => {
    const user = userEvent.setup();
    render(<PostActionLink postId={42} kind="hide" action={vi.fn(async () => {})} />);
    const link = screen.getByRole("link", { name: "屏蔽" });
    expect(link).toHaveAttribute("href", "/p/42/hide");
    await user.click(link);
    expect(screen.getByRole("dialog", { name: "屏蔽内容" })).toBeInTheDocument();
    expect(screen.getByLabelText("理由（必填）")).toBeRequired();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(link).toHaveFocus());
  });

  it("does not require an author deletion reason", async () => {
    const user = userEvent.setup();
    render(<PostActionLink postId={42} kind="delete" action={vi.fn(async () => {})} />);
    await user.click(screen.getByRole("link", { name: "删除" }));
    expect(screen.queryByLabelText("理由（必填）")).not.toBeInTheDocument();
  });

  it("弹窗表单只提交宿主注入的 Action，并保留帖子与理由输入", async () => {
    const action = vi.fn(async (_data: FormData) => {});
    const user = userEvent.setup();
    render(<PostActionLink postId={42} kind="hide" action={action} />);
    await user.click(screen.getByRole("link", { name: "屏蔽" }));
    await user.type(screen.getByLabelText("理由（必填）"), "违反版规");
    await user.click(screen.getByRole("button", { name: "确认屏蔽" }));

    expect(action).toHaveBeenCalledExactlyOnceWith(expect.any(FormData));
    const [data] = action.mock.calls[0];
    expect(data.get("postId")).toBe("42");
    expect(data.get("reason")).toBe("违反版规");
  });
});
