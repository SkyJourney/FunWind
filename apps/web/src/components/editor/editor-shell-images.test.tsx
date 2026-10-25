// @vitest-environment jsdom
/**
 * 外壳的图片插入（M6.4d2）：上传成功后图片出现在当前模式的编辑器里，并进入隐藏字段（即将提交的 Markdown）。
 * 富文本走图片节点，源码模式走 Markdown 图片语法。上传失败时给出原因，正文不变。
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorShell } from "./editor-shell";

const hidden = (c: HTMLElement) => c.querySelector<HTMLInputElement>('input[name="source"]')!;
const imageInput = () =>
  document.querySelector<HTMLInputElement>('input[type="file"][aria-label="选择图片"]')!;
const png = new File([new Uint8Array([137, 80, 78, 71])], "图.png", { type: "image/png" });

afterEach(() => vi.unstubAllGlobals());

function mount(initial = "") {
  return render(
    <EditorShell
      name="source"
      initialSource={initial}
      draftKey={null}
      restoreDraft={false}
      label="正文"
      forumId={901}
    />,
  );
}

const okUpload = () =>
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            fileId: 1,
            storageKey: "ab/cd/x.png",
            url: "/files/ab/cd/x.png",
            mime: "image/png",
            width: 1,
            height: 1,
            sizeBytes: 4,
          }),
          { status: 200 },
        ),
    ),
  );

describe("EditorShell：插入图片", () => {
  it("富文本模式：上传后图片进入正文（Markdown 图片语法）", async () => {
    okUpload();
    const user = userEvent.setup();
    const { container } = mount("开头");
    await screen.findByRole("toolbar", { name: "编辑工具栏" });
    await user.upload(imageInput(), png);
    await waitFor(() => expect(hidden(container).value).toContain("/files/ab/cd/x.png"));
    expect(hidden(container).value).toMatch(/!\[.*\]\(\/files\/ab\/cd\/x\.png\)/);
  });

  it("源码模式：上传后在光标处插入 Markdown 图片语法", async () => {
    okUpload();
    const user = userEvent.setup();
    const { container } = mount("开头");
    await screen.findByRole("toolbar", { name: "编辑工具栏" });
    await act(async () => {
      screen.getByRole("button", { name: "切换到源码" }).click();
    });
    await screen.findByRole("textbox", { name: "正文" });
    await user.upload(imageInput(), png);
    await waitFor(() => expect(hidden(container).value).toContain("![](/files/ab/cd/x.png)"));
  });

  it("上传失败：给出原因，正文保持不变", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "type_mismatch" }), { status: 415 })),
    );
    const user = userEvent.setup();
    const { container } = mount("原文");
    await screen.findByRole("toolbar", { name: "编辑工具栏" });
    await user.upload(imageInput(), png);
    expect(await screen.findByText("文件内容与扩展名不一致，已拒绝。")).toBeInTheDocument();
    expect(hidden(container).value).toBe("原文");
  });

  it("没有版块上下文时不显示插入图片与附件", () => {
    render(
      <EditorShell
        name="source"
        initialSource=""
        draftKey={null}
        restoreDraft={false}
        label="正文"
      />,
    );
    expect(screen.queryByRole("button", { name: "插入图片" })).toBeNull();
    expect(screen.queryByRole("region", { name: "附件" })).toBeNull();
  });
});
