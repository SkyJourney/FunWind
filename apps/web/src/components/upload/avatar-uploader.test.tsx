// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubUploadXhr, uploadOkBody } from "@/test/upload-xhr-double";
import { AvatarUploader } from "./avatar-uploader";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("./crop-dialog", () => ({
  CropDialog: ({
    file,
    onConfirm,
    onCancel,
  }: {
    file: File | null;
    onConfirm: (b: { x: number; y: number; width: number; height: number }) => void;
    onCancel: () => void;
  }) =>
    file ? (
      <div>
        <button type="button" onClick={() => onConfirm({ x: 0, y: 0, width: 200, height: 200 })}>
          保存头像
        </button>
        <button type="button" onClick={onCancel}>
          取消裁剪
        </button>
      </div>
    ) : null,
}));

const input = () => document.querySelector<HTMLInputElement>('input[aria-label="选择头像图片"]')!;
const png = new File([new Uint8Array([137, 80])], "a.png", { type: "image/png" });
const gif = new File([new Uint8Array([71, 73, 70])], "a.gif", { type: "image/gif" });
// 上传走 XHR（M16.1 Step 1），用替身接管全局 XMLHttpRequest
const ok = () =>
  uploadOkBody({
    fileId: 3,
    storageKey: "ab/cd/a.webp",
    url: "/files/ab/cd/a.webp",
    mime: "image/webp",
    width: 240,
    height: 240,
    sizeBytes: 9,
  });

afterEach(() => {
  vi.unstubAllGlobals();
  refresh.mockClear();
});

describe("AvatarUploader", () => {
  it("无头像时显示占位；选 PNG → 裁剪 → 保存：上传 purpose=avatar 并带裁剪框，成功后刷新", async () => {
    const xhr = stubUploadXhr();
    xhr.autoRespond(200, ok());
    const user = userEvent.setup();
    render(<AvatarUploader currentKey={null} name="小明" />);
    expect(screen.getByText("无头像")).toBeInTheDocument();
    await user.upload(input(), png);
    await user.click(await screen.findByRole("button", { name: "保存头像" }));
    expect(await screen.findByRole("status")).toHaveTextContent("头像已更新。");
    expect(refresh).toHaveBeenCalled();
    const call = xhr.calls[0]!;
    expect(call.url).toBe("/api/upload?purpose=avatar");
    expect(JSON.parse(call.body.get("crop") as string)).toEqual({
      x: 0,
      y: 0,
      width: 200,
      height: 200,
    });
    expect(screen.getByRole("img", { name: "小明 的当前头像" })).toHaveAttribute(
      "src",
      "/files/ab/cd/a.webp",
    );
  });

  it("GIF 不裁剪：直接上传（服务端取首帧居中裁切）", async () => {
    const xhr = stubUploadXhr();
    xhr.autoRespond(200, ok());
    const user = userEvent.setup();
    render(<AvatarUploader currentKey="ab/cd/old.png" name="小明" />);
    await user.upload(input(), gif);
    await waitFor(() => expect(xhr.calls).toHaveLength(1));
    const body = xhr.calls[0]!.body;
    expect(body.has("crop")).toBe(false);
    expect((body.get("file") as File).type).toBe("image/gif");
  });

  it("上传失败：展示原因，不刷新", async () => {
    const xhr = stubUploadXhr();
    xhr.autoRespond(403, JSON.stringify({ error: "avatar_restricted" }));
    const user = userEvent.setup();
    render(<AvatarUploader currentKey={null} name="小明" />);
    await user.upload(input(), gif);
    expect(await screen.findByRole("alert")).toHaveTextContent("当前账号不能设置头像。");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("取消裁剪：不上传，回到未选择状态", async () => {
    const xhr = stubUploadXhr();
    xhr.autoRespond(200, ok());
    const user = userEvent.setup();
    render(<AvatarUploader currentKey={null} name="小明" />);
    await user.upload(input(), png);
    await user.click(await screen.findByRole("button", { name: "取消裁剪" }));
    expect(screen.queryByRole("button", { name: "保存头像" })).toBeNull();
    expect(xhr.calls).toHaveLength(0);
  });

  it("「选择头像」按钮打开系统选择框（转发点击到隐藏的文件输入）", async () => {
    const user = userEvent.setup();
    render(<AvatarUploader currentKey={null} name="小明" />);
    const clicked = vi.spyOn(input(), "click");
    await user.click(screen.getByRole("button", { name: "选择头像" }));
    expect(clicked).toHaveBeenCalled();
  });

  it("按钮在上传中禁用", async () => {
    const xhr = stubUploadXhr(); // 不自动响应：停在上传中，由用例手动完成
    const user = userEvent.setup();
    render(<AvatarUploader currentKey={null} name="小明" />);
    await user.upload(input(), gif);
    expect(await screen.findByRole("button", { name: "上传中…" })).toBeDisabled();
    // 上行进度可见：45% → 上行完成后切「处理中…」（服务端还在裁切）
    await act(async () => xhr.calls[0]!.progress(45, 100));
    expect(screen.getByRole("progressbar", { name: "头像上传进度" })).toHaveAttribute(
      "aria-valuenow",
      "45",
    );
    await act(async () => xhr.calls[0]!.uploaded());
    expect(screen.getByText("处理中…")).toBeInTheDocument();
    await act(async () => xhr.calls[0]!.respond(200, ok()));
    await waitFor(() => expect(screen.getByRole("button", { name: "选择头像" })).toBeEnabled());
  });
});
