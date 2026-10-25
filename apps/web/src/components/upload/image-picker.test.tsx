// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ImagePicker, imageFileFromClipboard } from "./image-picker";

const png = new File([new Uint8Array([137])], "图.png", { type: "image/png" });

describe("ImagePicker", () => {
  it("选择图片：默认直接插入（不裁剪）", async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    render(<ImagePicker onPick={onPick} />);
    await user.upload(screen.getByLabelText("选择图片"), png);
    expect(onPick).toHaveBeenCalledWith(png, false);
  });

  it("勾选「裁剪后插入」后，选择的图片带上裁剪标记", async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    render(<ImagePicker onPick={onPick} />);
    await user.click(screen.getByRole("checkbox", { name: "裁剪后插入" }));
    await user.upload(screen.getByLabelText("选择图片"), png);
    expect(onPick).toHaveBeenCalledWith(png, true);
  });

  it("禁用时按钮不可点", () => {
    render(<ImagePicker disabled onPick={() => {}} />);
    expect(screen.getByRole("button", { name: "插入图片" })).toBeDisabled();
  });
});

describe("imageFileFromClipboard", () => {
  const dt = (items: { kind: string; type: string; file?: File | null }[]) =>
    ({
      items: items.map((i) => ({ kind: i.kind, type: i.type, getAsFile: () => i.file ?? null })),
    }) as unknown as DataTransfer;

  it("取出剪贴板中的图片", () => {
    expect(
      imageFileFromClipboard(
        dt([
          { kind: "string", type: "text/plain" },
          { kind: "file", type: "image/png", file: png },
        ]),
      ),
    ).toBe(png);
  });

  it("纯文本、空剪贴板、图片项取不到文件：返回 null", () => {
    expect(imageFileFromClipboard(dt([{ kind: "string", type: "text/plain" }]))).toBeNull();
    expect(imageFileFromClipboard(null)).toBeNull();
    expect(
      imageFileFromClipboard(dt([{ kind: "file", type: "image/png", file: null }])),
    ).toBeNull();
  });
});
