import type { FormEvent } from "react";
// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentPanel } from "./attachment-panel";

const KEY = "funwind:draft:1:edit:33";
const fileInput = () =>
  document.querySelector<HTMLInputElement>('input[type="file"][aria-label="选择附件"]')!;

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

/** 附件列表默认折叠（M10.8 Step 9）：需要看行时先展开 */
const expand = () => {
  const t = screen.getByRole("button", { name: /^附件（\d+）$/ });
  // 从暂存恢复时已自动展开：只在折叠时才点
  if (t.getAttribute("aria-expanded") === "false") fireEvent.click(t);
};

describe("AttachmentPanel 补充", () => {
  it("大小按单位显示：KB 与 MB", () => {
    render(
      <AttachmentPanel
        forumId={901}
        gateKeys={[]}
        initial={[
          { fileId: 1, name: "小.zip", sizeBytes: 900, gateKey: null },
          { fileId: 2, name: "大.zip", sizeBytes: 3 * 1024 * 1024, gateKey: null },
        ]}
        draftKey={null}
        restoreDraft={false}
      />,
    );
    expand();
    expect(screen.getByText("900 B")).toBeInTheDocument();
    expect(screen.getByText("3.0 MB")).toBeInTheDocument();
  });

  it("暂存数据损坏（非数组）时回落到服务端给出的列表", () => {
    window.localStorage.setItem(`${KEY}:attachments:sent`, JSON.stringify({ not: "a list" }));
    render(
      <AttachmentPanel
        forumId={901}
        gateKeys={[]}
        initial={[{ fileId: 4, name: "服务端.zip", sizeBytes: 1, gateKey: null }]}
        draftKey={KEY}
        restoreDraft
      />,
    );
    expand();
    expect(screen.getByText("服务端.zip")).toBeInTheDocument();
  });

  it("网络异常：统一给出可读提示", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    const user = userEvent.setup();
    render(
      <AttachmentPanel
        forumId={901}
        gateKeys={[]}
        initial={[]}
        draftKey={null}
        restoreDraft={false}
      />,
    );
    await user.upload(fileInput(), new File(["x"], "n.zip", { type: "application/zip" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("网络异常");
  });

  it("提交表单时把列表暂存（失败跳回时可恢复）", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((e: FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <AttachmentPanel
          forumId={901}
          gateKeys={[]}
          initial={[{ fileId: 8, name: "提交.zip", sizeBytes: 1, gateKey: null }]}
          draftKey={KEY}
          restoreDraft={false}
        />
        <button type="submit">提交</button>
      </form>,
    );
    // 先让草稿键里有内容（列表变化才会写入），再提交
    expand();
    await user.click(screen.getByRole("button", { name: "移除附件：提交.zip" }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ fileId: 8, sizeBytes: 1 }), { status: 200 })),
    );
    await user.upload(fileInput(), new File(["x"], "再加.zip", { type: "application/zip" }));
    await screen.findByText("再加.zip");
    fireEvent.submit(document.querySelector("form")!);
    await waitFor(() =>
      expect(window.localStorage.getItem(`${KEY}:attachments:sent`)).not.toBeNull(),
    );
    expect(window.localStorage.getItem(`${KEY}:attachments`)).toBeNull();
  });
});
