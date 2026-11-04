import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  UserEmailPanel,
  describeEmailVerification,
  type EmailPanelDetail,
} from "./user-email-panel";

const base: EmailPanelDetail = {
  id: 43,
  email: "user@example.com",
  emailVerifiedAt: null,
  emailVerificationRequired: false,
  loginVerificationRequired: false,
};
const noop = async () => {};

describe("describeEmailVerification", () => {
  it.each([
    ["已验证", { emailVerifiedAt: "2026-11-01 10:00:00" }, "邮箱已验证", "success"],
    [
      "登录门未解除：注册后一直没验证，无法登录",
      { emailVerificationRequired: true, loginVerificationRequired: true },
      "注册后未验证，无法登录",
      "warning",
    ],
    [
      "改绑后重验：只拦写权限",
      { emailVerificationRequired: true },
      "邮箱待验证（写入受限）",
      "warning",
    ],
    ["账号未要求验证", {}, "邮箱未验证（账号未要求验证）", "warning"],
  ] as const)("%s", (_name, over, label, tone) => {
    expect(describeEmailVerification({ ...base, ...over })).toEqual({ label, tone });
  });

  it("已验证优先于其他标记（验证成功时登录门已被清除，旧标记不应再误导）", () => {
    expect(
      describeEmailVerification({
        ...base,
        emailVerifiedAt: "2026-11-01 10:00:00",
        emailVerificationRequired: true,
        loginVerificationRequired: true,
      }).label,
    ).toBe("邮箱已验证");
  });
});

describe("UserEmailPanel", () => {
  it("显示当前邮箱与状态，并带改邮箱表单（隐藏的 userId + 必填邮箱）", () => {
    render(<UserEmailPanel detail={base} canEdit action={noop} />);
    const panel = screen.getByTestId("user-email-panel");
    expect(within(panel).getByTestId("user-email-current")).toHaveTextContent("user@example.com");
    expect(within(panel).getByTestId("user-email-status")).toHaveTextContent(
      "邮箱未验证（账号未要求验证）",
    );
    const input = within(panel).getByLabelText("新邮箱");
    expect(input).toBeRequired();
    expect(input).toHaveAttribute("type", "email");
    expect(input).toHaveAttribute("name", "email");
    expect(panel.querySelector('input[name="userId"]')).toHaveValue("43");
    expect(
      within(panel).getByRole("button", { name: "修改邮箱并发送验证邮件" }),
    ).toBeInTheDocument();
  });

  it("只读账号（已注销 / 注销冷静期）仍显示状态，但不显示表单", () => {
    render(<UserEmailPanel detail={base} canEdit={false} action={noop} />);
    const panel = screen.getByTestId("user-email-panel");
    expect(within(panel).getByTestId("user-email-status")).toBeInTheDocument();
    expect(within(panel).queryByLabelText("新邮箱")).toBeNull();
    expect(within(panel).queryByRole("button")).toBeNull();
  });

  it("无邮箱账号显示占位文案", () => {
    render(<UserEmailPanel detail={{ ...base, email: null }} canEdit action={noop} />);
    expect(screen.getByTestId("user-email-current")).toHaveTextContent("（无邮箱）");
  });

  it("说明文字写明：用户需重新验证、门未解除的账号仍无法登录、操作留痕", () => {
    render(<UserEmailPanel detail={base} canEdit action={noop} />);
    const text = screen.getByTestId("user-email-panel").textContent ?? "";
    expect(text).toContain("用户需要重新验证新邮箱");
    expect(text).toContain("验证完成前仍无法登录");
    expect(text).toContain("审计日志");
  });
});
