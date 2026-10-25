// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
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
const ok = () =>
  new Response(
    JSON.stringify({
      fileId: 3,
      storageKey: "ab/cd/a.webp",
      url: "/files/ab/cd/a.webp",
      mime: "image/webp",
      width: 240,
      height: 240,
      sizeBytes: 9,
    }),
    {
      status: 200,
    },
  );

afterEach(() => {
  vi.unstubAllGlobals();
  refresh.mockClear();
});

describe("AvatarUploader", () => {
  it("无头像时显示占位；选 PNG → 裁剪 → 保存：上传 purpose=avatar 并带裁剪框，成功后刷新", async () => {
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AvatarUploader currentKey={null} name="小明" />);
    expect(screen.getByText("无头像")).toBeInTheDocument();
    await user.upload(input(), png);
    await user.click(await screen.findByRole("button", { name: "保存头像" }));
    expect(await screen.findByRole("status")).toHaveTextContent("头像已更新。");
    expect(refresh).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/upload?purpose=avatar");
    expect(JSON.parse((init.body as FormData).get("crop") as string)).toEqual({
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
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AvatarUploader currentKey="ab/cd/old.png" name="小明" />);
    await user.upload(input(), gif);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as FormData;
    expect(body.has("crop")).toBe(false);
    expect((body.get("file") as File).type).toBe("image/gif");
  });

  it("上传失败：展示原因，不刷新", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ error: "avatar_restricted" }), { status: 403 }),
      ),
    );
    const user = userEvent.setup();
    render(<AvatarUploader currentKey={null} name="小明" />);
    await user.upload(input(), gif);
    expect(await screen.findByRole("alert")).toHaveTextContent("当前账号不能设置头像。");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("取消裁剪：不上传，回到未选择状态", async () => {
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AvatarUploader currentKey={null} name="小明" />);
    await user.upload(input(), png);
    await user.click(await screen.findByRole("button", { name: "取消裁剪" }));
    expect(screen.queryByRole("button", { name: "保存头像" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("「选择头像」按钮打开系统选择框（转发点击到隐藏的文件输入）", async () => {
    const user = userEvent.setup();
    render(<AvatarUploader currentKey={null} name="小明" />);
    const clicked = vi.spyOn(input(), "click");
    await user.click(screen.getByRole("button", { name: "选择头像" }));
    expect(clicked).toHaveBeenCalled();
  });

  it("按钮在上传中禁用", async () => {
    let finish!: (r: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((r) => (finish = r))),
    );
    const user = userEvent.setup();
    render(<AvatarUploader currentKey={null} name="小明" />);
    await user.upload(input(), gif);
    expect(await screen.findByRole("button", { name: "上传中…" })).toBeDisabled();
    await act(async () => finish(ok()));
    await waitFor(() => expect(screen.getByRole("button", { name: "选择头像" })).toBeEnabled());
  });
});
