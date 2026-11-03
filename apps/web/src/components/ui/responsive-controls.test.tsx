import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./button";
import { SubmitButton } from "./submit-button";
import { FileInput } from "./file-input";
import { FileName } from "./file-name";
import { ActionGroup } from "./action-group";
import { BrandFileInput } from "@/components/admin/brand-file-input";

const longName = `${"UnbrokenFilename0123456789".repeat(8)}混合名称.png`;

describe("自适应操作与文件控件契约", () => {
  it("普通与提交按钮共享单行防收缩基线，同时保留调用方属性", () => {
    render(
      <ActionGroup aria-label="操作区">
        <Button>普通动作</Button>
        <form>
          <SubmitButton
            name="intent"
            value="save"
            pendingText="处理中…"
            className="text-destructive"
          >
            保存操作
          </SubmitButton>
        </form>
      </ActionGroup>,
    );
    expect(screen.getByLabelText("操作区")).toHaveClass("min-w-0", "max-w-full", "flex-wrap");
    for (const button of screen.getAllByRole("button"))
      expect(button).toHaveClass("shrink-0", "whitespace-nowrap");
    expect(screen.getByRole("button", { name: "保存操作" })).toHaveAttribute("type", "submit");
    expect(screen.getByRole("button", { name: "保存操作" })).toHaveAttribute("name", "intent");
    expect(screen.getByRole("button", { name: "保存操作" })).toHaveClass("text-destructive");
  });

  it("长文件名完整显示并可在容器内断行", () => {
    render(<FileName name={longName} />);
    expect(screen.getByText(longName)).toHaveAttribute("title", longName);
    expect(screen.getByText(longName)).toHaveClass("min-w-0", "[overflow-wrap:anywhere]");
  });

  it("原生多文件输入保留表单与可访问属性，完整展示选择名称", () => {
    const changed = vi.fn();
    render(
      <FileInput
        name="files"
        multiple
        required
        accept="image/png"
        aria-label="素材文件"
        onChange={changed}
      />,
    );
    const input = screen.getByLabelText("素材文件");
    fireEvent.change(input, {
      target: {
        files: [
          new File(["a"], longName, { type: "image/png" }),
          new File(["b"], "第二张.png", { type: "image/png" }),
        ],
      },
    });
    expect(changed).toHaveBeenCalledOnce();
    expect(input).toHaveAttribute("name", "files");
    expect(input).toHaveAttribute("multiple");
    expect(input).toHaveAttribute("required");
    expect(input).toHaveClass("min-w-0", "max-w-full", "w-full");
    expect(screen.getByText(longName)).toHaveAttribute("title", longName);
    expect(screen.getByText("第二张.png")).toBeVisible();
    const describedBy = input.getAttribute("aria-describedby");
    expect(document.getElementById(describedBy!)).toHaveTextContent(longName);
  });

  it("品牌文件校验失败仍清空原生输入并提供可断行错误，合法文件不丢名称", () => {
    render(<BrandFileInput maxBytes={1024} hint="建议小图" />);
    const input = screen.getByLabelText(/PNG 文件/);
    fireEvent.change(input, {
      target: {
        files: [new File(["a"], longName.replace(".png", ".jpg"), { type: "image/jpeg" })],
      },
    });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("不是 PNG");
    expect(screen.getByRole("alert")).toHaveClass("[overflow-wrap:anywhere]");
    fireEvent.change(input, {
      target: { files: [new File(["a"], longName, { type: "image/png" })] },
    });
    expect(input).toHaveAttribute("aria-invalid", "false");
    expect(screen.getByText(`已选 ${longName}`)).toBeVisible();
  });
});
