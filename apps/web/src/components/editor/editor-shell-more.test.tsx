// @vitest-environment jsdom
/**
 * 外壳的图片补充行为（M6.4d2）：裁剪确认 / 取消（对话框以桩替换，真实裁剪的拖拽不在 jsdom 测）、
 * GIF 不裁剪的提示、粘贴截图、上传期间禁用提交、输入法组合中延后插入。
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubUploadXhr, uploadOkBody } from "@/test/upload-xhr-double";
import { EditorShell } from "./editor-shell";

vi.mock("@/components/upload/crop-dialog", () => ({
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
        <button type="button" onClick={() => onConfirm({ x: 1, y: 2, width: 40, height: 40 })}>
          确认裁剪
        </button>
        <button type="button" onClick={onCancel}>
          取消裁剪
        </button>
      </div>
    ) : null,
}));

const hidden = (c: HTMLElement) => c.querySelector<HTMLInputElement>('input[name="source"]')!;
const imageInput = () =>
  document.querySelector<HTMLInputElement>('input[type="file"][aria-label="选择图片"]')!;
const png = new File([new Uint8Array([137, 80, 78, 71])], "图.png", { type: "image/png" });
const gif = new File([new Uint8Array([71, 73, 70])], "动.gif", { type: "image/gif" });

afterEach(() => vi.unstubAllGlobals());

// 上传走 XHR（M16.1 Step 1）：reply 返回响应体字符串，交给替身回应
const reply = (url = "/files/ab/cd/z.png") =>
  uploadOkBody({
    fileId: 1,
    storageKey: "ab/cd/z.png",
    url,
    mime: "image/png",
    width: 40,
    height: 40,
    sizeBytes: 4,
  });

function mount(extra: { form?: boolean } = {}) {
  const shell = (
    <EditorShell
      name="source"
      initialSource=""
      draftKey={null}
      restoreDraft={false}
      label="正文"
      forumId={901}
    />
  );
  return render(
    extra.form ? (
      <form>
        {shell}
        <button type="submit">发布</button>
      </form>
    ) : (
      shell
    ),
  );
}

describe("EditorShell：裁剪与 GIF", () => {
  it("勾选裁剪并选择 PNG：打开裁剪；确认后带着裁剪框上传并插入", async () => {
    const xhr = stubUploadXhr();
    xhr.autoRespond(200, reply());
    const user = userEvent.setup();
    const { container } = mount();
    await screen.findByRole("toolbar", { name: "编辑工具栏" });
    await user.click(screen.getByRole("button", { name: "裁剪后插入" }));
    await user.upload(imageInput(), png);
    await user.click(await screen.findByRole("button", { name: "确认裁剪" }));
    await waitFor(() => expect(hidden(container).value).toContain("/files/ab/cd/z.png"));
    const body = xhr.calls[0]!.body;
    expect(JSON.parse(body.get("crop") as string)).toEqual({ x: 1, y: 2, width: 40, height: 40 });
  });

  it("取消裁剪：不上传，正文不变", async () => {
    const xhr = stubUploadXhr();
    xhr.autoRespond(200, reply());
    const user = userEvent.setup();
    const { container } = mount();
    await screen.findByRole("toolbar", { name: "编辑工具栏" });
    await user.click(screen.getByRole("button", { name: "裁剪后插入" }));
    await user.upload(imageInput(), png);
    await user.click(await screen.findByRole("button", { name: "取消裁剪" }));
    expect(xhr.calls).toHaveLength(0);
    expect(hidden(container).value).toBe("");
  });

  it("GIF 不裁剪：直接上传插入，并提示原因", async () => {
    const xhr = stubUploadXhr();
    xhr.autoRespond(200, reply("/files/ab/cd/g.gif"));
    const user = userEvent.setup();
    mount();
    await screen.findByRole("toolbar", { name: "编辑工具栏" });
    await user.click(screen.getByRole("button", { name: "裁剪后插入" }));
    await user.upload(imageInput(), gif);
    // 语义拆分（M16.1 Step 2）：这是成功说明，必须是 status 而非 alert，也不该是错误红字
    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent("GIF 不支持裁剪，已直接插入。");
    expect(notice.className).not.toContain("text-destructive");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(xhr.calls).toHaveLength(1);
  });

  it("上传失败：提示是 alert 且用错误色（与成功说明区分，M16.1 Step 2）", async () => {
    const xhr = stubUploadXhr();
    xhr.autoRespond(415, JSON.stringify({ error: "type_mismatch" }));
    const user = userEvent.setup();
    mount();
    await screen.findByRole("toolbar", { name: "编辑工具栏" });
    await user.upload(imageInput(), png);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("文件内容与扩展名不一致，已拒绝。");
    expect(alert.className).toContain("text-destructive");
  });
});

describe("EditorShell：粘贴与提交状态", () => {
  it("粘贴截图：拦截并上传插入；纯文本粘贴不受影响", async () => {
    const xhr = stubUploadXhr();
    xhr.autoRespond(200, reply());
    const { container } = mount();
    await screen.findByRole("toolbar", { name: "编辑工具栏" });
    const root = container.firstChild as HTMLElement;
    fireEvent.paste(root, {
      clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => png }] },
    });
    await waitFor(() => expect(hidden(container).value).toContain("/files/ab/cd/z.png"));
    expect(xhr.calls).toHaveLength(1);
    fireEvent.paste(root, {
      clipboardData: { items: [{ kind: "string", type: "text/plain", getAsFile: () => null }] },
    });
    expect(xhr.calls).toHaveLength(1);
  });

  it("上传进行中禁用提交按钮，完成后恢复", async () => {
    const xhr = stubUploadXhr(); // 不自动响应：停在上传中
    const user = userEvent.setup();
    mount({ form: true });
    await screen.findByRole("toolbar", { name: "编辑工具栏" });
    const submit = screen.getByRole("button", { name: "发布" });
    await user.upload(imageInput(), png);
    await waitFor(() => expect(submit).toBeDisabled());
    await act(async () => xhr.calls[0]!.respond(200, reply()));
    await waitFor(() => expect(submit).toBeEnabled());
  });

  it("输入法组合中：插入延后到 compositionend", async () => {
    const xhr = stubUploadXhr();
    xhr.autoRespond(200, reply());
    const user = userEvent.setup();
    const { container } = mount();
    await screen.findByRole("toolbar", { name: "编辑工具栏" });
    const editable = container.querySelector<HTMLElement>('[contenteditable="true"]')!;
    fireEvent.compositionStart(editable);
    await user.upload(imageInput(), png);
    await new Promise((r) => setTimeout(r, 20));
    expect(hidden(container).value).not.toContain("/files/ab/cd/z.png");
    await act(async () => {
      fireEvent.compositionEnd(editable);
    });
    await waitFor(() => expect(hidden(container).value).toContain("/files/ab/cd/z.png"));
  });
});

describe("EditorShell：图片入口按模式分工（M10.8 Step 9）", () => {
  it("所见即所得：入口在工具栏（上传图片 + 裁剪开关），编辑区下方没有重复的按钮与勾选框", async () => {
    render(
      <EditorShell
        name="source"
        initialSource=""
        draftKey={null}
        restoreDraft={false}
        label="正文"
        forumId={901}
      />,
    );
    await screen.findByRole("toolbar", { name: "编辑工具栏" });
    expect(screen.getByRole("button", { name: "上传图片" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "裁剪后插入" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.queryByRole("button", { name: "插入图片" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "裁剪后插入" })).toBeNull();
    // 文件框仍在（工具栏按钮经它打开选择器）
    expect(document.querySelector('input[type="file"][aria-label="选择图片"]')).not.toBeNull();
  });

  it("源码模式：没有工具栏，保留编辑区下方的「插入图片」与「裁剪后插入」勾选框；两种模式共用同一个裁剪状态", async () => {
    const user = userEvent.setup();
    render(
      <EditorShell
        name="source"
        initialSource=""
        draftKey={null}
        restoreDraft={false}
        label="正文"
        forumId={901}
      />,
    );
    await screen.findByRole("toolbar", { name: "编辑工具栏" });
    await user.click(screen.getByRole("button", { name: "裁剪后插入" })); // 在工具栏打开
    await user.click(screen.getByRole("button", { name: "切换到源码" }));
    expect(await screen.findByRole("button", { name: "插入图片" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "裁剪后插入" })).toBeChecked();
  });
});
