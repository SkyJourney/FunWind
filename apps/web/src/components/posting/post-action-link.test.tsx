import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/posts", () => ({ deletePostAction: vi.fn(), restorePostAction: vi.fn() }));
vi.mock("@/app/admin/review/actions", () => ({ hidePostAction: vi.fn() }));
vi.mock("@/app/actions/reports", () => ({ reportPostAction: vi.fn() }));
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
});
