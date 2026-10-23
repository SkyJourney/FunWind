import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "./button";

describe("Button", () => {
  it("默认变体渲染主要色类", () => {
    render(<Button>主要</Button>);
    expect(screen.getByRole("button", { name: "主要" })).toHaveClass("bg-primary");
  });

  it("outline 变体带描边", () => {
    render(<Button variant="outline">描边</Button>);
    expect(screen.getByRole("button", { name: "描边" })).toHaveClass("border");
  });

  it("disabled 态不可点击样式生效", () => {
    render(<Button disabled>禁用</Button>);
    expect(screen.getByRole("button", { name: "禁用" })).toBeDisabled();
  });

  it("支持 asChild 透传子元素", () => {
    render(
      <Button asChild>
        <a href="/docs">文档链接</a>
      </Button>,
    );
    expect(screen.getByRole("link", { name: "文档链接" })).toBeInTheDocument();
  });
});
