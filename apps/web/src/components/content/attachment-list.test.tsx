import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AttachmentView, OpenAttachment } from "@/lib/gates/attachments";
import { AttachmentList } from "./attachment-list";

const open: OpenAttachment = {
  status: "open",
  id: 1,
  postId: 17,
  originalName: "公开附件.zip",
  downloads: 4,
  storageKey: "public-key.zip",
  mime: "application/zip",
  sizeBytes: 123,
};
const locked: AttachmentView = { status: "locked", postId: 17, gateKey: "g1" };

describe("服务端附件展示与门控", () => {
  it("无附件不产生包裹 DOM", () => {
    const { container } = render(<AttachmentList attachments={[]} canDownload isGuest={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("可下载的公开附件保留地址、原名、下载次数与原 DOM 类", () => {
    const { container } = render(
      <AttachmentList attachments={[open, locked]} canDownload isGuest={false} />,
    );
    expect(screen.getByRole("link")).toHaveAttribute("href", "/files/public-key.zip");
    expect(screen.getByRole("link")).toHaveTextContent("公开附件.zip（4 次下载）");
    expect(container.firstChild).toHaveClass("mt-4 flex flex-wrap gap-2 border-t pt-3", {
      exact: true,
    });
    expect(screen.getByTestId("locked-attachments")).toHaveTextContent(
      "本帖有 1 个附件需解锁后下载",
    );
  });

  it.each([
    [true, "登录后下载"],
    [false, "无下载权限"],
  ] as const)("无下载权时仅显示原名与说明（游客=%s），不输出存储键", (isGuest, text) => {
    const { container } = render(
      <AttachmentList attachments={[open]} canDownload={false} isGuest={isGuest} />,
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText(`（${text}）`)).toBeInTheDocument();
    expect(container).toHaveTextContent("公开附件.zip");
    expect(container.innerHTML).not.toContain(open.storageKey);
    expect(container.innerHTML).not.toContain(String(open.sizeBytes));
  });

  it("锁定项只计数：即使错误附带元数据，也不读取或输出；权限为真不能绕过附件门控", () => {
    const readMetadata = vi.fn(() => {
      throw new Error("不应读取锁定附件元数据");
    });
    const poisoned = {
      ...locked,
      ...Object.fromEntries(
        ["originalName", "storageKey", "sizeBytes", "downloads", "mime"].map((key) => [
          key,
          undefined,
        ]),
      ),
    };
    for (const key of ["originalName", "storageKey", "sizeBytes", "downloads", "mime"])
      Object.defineProperty(poisoned, key, { get: readMetadata });
    const { container } = render(
      <AttachmentList attachments={[locked, poisoned]} canDownload isGuest={false} />,
    );
    expect(readMetadata).not.toHaveBeenCalled();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByTestId("locked-attachments")).toHaveTextContent(
      "本帖有 2 个附件需解锁后下载",
    );
    expect(container.innerHTML).not.toContain("g1");
    expect(container.querySelectorAll("[href]")).toHaveLength(0);
  });
});
