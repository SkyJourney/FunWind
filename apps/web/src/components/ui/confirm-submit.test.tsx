import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfirmSubmit } from "./confirm-submit";

describe("ConfirmSubmit", () => {
  it("validates, cancels and submits only after confirmation", async () => {
    const user = userEvent.setup();
    const submit = vi.fn();
    const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
      if (!event.defaultPrevented) submit();
      event.preventDefault();
    };
    render(
      <form onSubmit={onSubmit}>
        <label>
          理由
          <input name="reason" required />
        </label>
        <ConfirmSubmit title="删除内容" description="确认删除？">
          删除
        </ConfirmSubmit>
      </form>,
    );
    const trigger = screen.getByRole("button", { name: "删除" });
    await user.click(trigger);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("理由"), "测试{Enter}");
    expect(screen.getByRole("dialog", { name: "删除内容" })).toBeInTheDocument();
    expect(submit).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(submit).not.toHaveBeenCalled();
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "确认" }));
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("renders a normal submit button for progressive enhancement", () => {
    render(
      <form>
        <ConfirmSubmit title="确认" description="确认操作？">
          提交
        </ConfirmSubmit>
      </form>,
    );
    expect(screen.getByRole("button", { name: "提交" })).toHaveAttribute("type", "submit");
  });
});
