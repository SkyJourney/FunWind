import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Field, SubmitButton } from "./ui-bits";

describe("认证页基础控件", () => {
  it("保留字段标签和表单属性", () => {
    render(
      <Field label="邮箱" name="email" type="email" placeholder="邮箱地址" autoComplete="email" />,
    );
    const input = screen.getByLabelText("邮箱");
    expect(input).toHaveAttribute("data-slot", "input");
    expect(input).toHaveAttribute("name", "email");
    expect(input).toHaveAttribute("type", "email");
    expect(input).toHaveAttribute("autocomplete", "email");
    expect(input).toBeRequired();
  });

  it("支持可选字段及提交按钮", () => {
    render(
      <form>
        <Field label="邀请码" name="invite" required={false} />
        <SubmitButton label="注册" />
      </form>,
    );
    expect(screen.getByLabelText("邀请码")).not.toBeRequired();
    expect(screen.getByRole("button", { name: "注册" })).toHaveAttribute("type", "submit");
    expect(screen.getByRole("button", { name: "注册" })).toHaveAttribute("data-slot", "button");
  });
});
