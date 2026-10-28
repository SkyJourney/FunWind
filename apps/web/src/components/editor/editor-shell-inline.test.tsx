// @vitest-environment jsdom
/**
 * 内嵌图片 ↔ 附件面板联动（M10.8 Step 4）：正文是唯一事实来源，「正文图片」组由正文派生。
 * 上传 → 出现条目；移除条目 → 删正文引用（富文本与源码两种模式）；已上传的图片附件可「插入正文」并转入正文图片组。
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorShell } from "./editor-shell";

const H = "a".repeat(64);
const KEY = `aa/aa/${H}.png`;
const URL_ = `/files/${KEY}`;

const hidden = (c: HTMLElement) => c.querySelector<HTMLInputElement>('input[name="source"]')!;
const imageInput = () =>
  document.querySelector<HTMLInputElement>('input[type="file"][aria-label="选择图片"]')!;
const png = new File([new Uint8Array([137, 80, 78, 71])], "图.png", { type: "image/png" });
const inlineRows = () => screen.queryAllByTestId("inline-image-row");
const attachRows = () => screen.queryAllByTestId("attachment-row");

afterEach(() => vi.unstubAllGlobals());

const okUpload = () =>
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            fileId: 1,
            storageKey: KEY,
            url: URL_,
            mime: "image/png",
            width: 1,
            height: 1,
            sizeBytes: 4,
          }),
          { status: 200 },
        ),
    ),
  );

function mount(
  initial = "",
  attachments: Parameters<typeof EditorShell>[0]["initialAttachments"] = [],
) {
  return render(
    <EditorShell
      name="source"
      initialSource={initial}
      draftKey={null}
      restoreDraft={false}
      label="正文"
      forumId={901}
      initialAttachments={attachments}
    />,
  );
}

describe("正文图片组：从正文派生", () => {
  it("上传后出现条目；点移除删掉正文里的图片引用，条目随之消失（富文本）", async () => {
    okUpload();
    const user = userEvent.setup();
    const { container } = mount("开头");
    await screen.findByRole("toolbar", { name: "编辑工具栏" });
    expect(inlineRows()).toHaveLength(0);
    await user.upload(imageInput(), png);
    await waitFor(() => expect(inlineRows()).toHaveLength(1));
    expect(hidden(container).value).toContain(URL_);
    await user.click(screen.getByRole("button", { name: "移除正文图片：图片 1" }));
    await waitFor(() => expect(hidden(container).value).not.toContain(URL_));
    expect(inlineRows()).toHaveLength(0);
    expect(hidden(container).value).toContain("开头");
  });

  it("源码模式：移除条目同样删掉 Markdown 图片语法", async () => {
    const user = userEvent.setup();
    const { container } = mount(`前 ![](${URL_}) 后`);
    expect(inlineRows()).toHaveLength(1); // 初始正文里就有的图（编辑旧帖）
    await act(async () => {
      screen.getByRole("button", { name: "切换到源码" }).click();
    });
    await screen.findByRole("textbox", { name: "正文" });
    await user.click(screen.getByRole("button", { name: "移除正文图片：图片 1" }));
    await waitFor(() => expect(hidden(container).value).not.toContain(URL_));
    expect(hidden(container).value).toContain("前");
    expect(hidden(container).value).toContain("后");
    expect(inlineRows()).toHaveLength(0);
  });

  it("同一张图在正文里出现多次：只算一条，移除时全部删掉", async () => {
    const user = userEvent.setup();
    const { container } = mount(`![](${URL_}) 中 ![x](${URL_})`);
    await waitFor(() => expect(inlineRows()).toHaveLength(1));
    await act(async () => {
      screen.getByRole("button", { name: "切换到源码" }).click();
    });
    await screen.findByRole("textbox", { name: "正文" });
    await user.click(screen.getByRole("button", { name: "移除正文图片：图片 1" }));
    await waitFor(() => expect(hidden(container).value).not.toContain(URL_));
  });

  it("表情与站外图不进正文图片组", () => {
    mount("![表情](/emoji/134.gif) ![外](https://a.cn/x.png)");
    expect(inlineRows()).toHaveLength(0);
  });
});

describe("工具栏「上传图片」按钮", () => {
  it("点击打开与下方图片选择器同一个文件框（共用裁剪选项）", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("toolbar", { name: "编辑工具栏" });
    const spy = vi.spyOn(HTMLInputElement.prototype, "click");
    await user.click(screen.getByRole("button", { name: "上传图片" }));
    expect(spy.mock.contexts.some((el) => el === imageInput())).toBe(true);
    spy.mockRestore();
  });

  it("没有版块上下文时工具栏不出现该按钮", async () => {
    render(
      <EditorShell
        name="source"
        initialSource=""
        draftKey={null}
        restoreDraft={false}
        label="正文"
      />,
    );
    await screen.findByRole("toolbar", { name: "编辑工具栏" });
    expect(screen.queryByRole("button", { name: "上传图片" })).toBeNull();
  });
});

describe("已上传的图片附件：插入正文", () => {
  const item = {
    fileId: 5,
    name: "封面.png",
    sizeBytes: 100,
    gateKey: null,
    storageKey: KEY,
    mime: "image/png",
  };

  it("点「插入正文」：图片进入正文，附件转入正文图片组（不再留在下载列表）；移除后附件回到下载列表", async () => {
    const user = userEvent.setup();
    const { container } = mount("", [item]);
    await screen.findByRole("toolbar", { name: "编辑工具栏" });
    expect(attachRows()).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "插入正文：封面.png" }));
    await waitFor(() => expect(hidden(container).value).toContain(URL_));
    await waitFor(() => expect(inlineRows()).toHaveLength(1));
    expect(attachRows()).toHaveLength(0);
    expect(screen.getByRole("heading", { name: "附件（0）" })).toBeInTheDocument();
    // 提交的附件列表仍带着它（服务端按「被正文引用即不再作下载附件」去重）
    const att = container.querySelector<HTMLInputElement>('input[name="attachments"]')!;
    expect(JSON.parse(att.value)).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "移除正文图片：图片 1" }));
    await waitFor(() => expect(attachRows()).toHaveLength(1));
    expect(within(attachRows()[0]!).getByText("封面.png")).toBeInTheDocument();
  });

  it("非图片附件、缺少存储键的旧草稿附件没有「插入正文」", () => {
    mount("", [
      {
        fileId: 6,
        name: "字幕.zip",
        sizeBytes: 1,
        gateKey: null,
        storageKey: KEY,
        mime: "application/zip",
      },
      { fileId: 7, name: "旧.png", sizeBytes: 1, gateKey: null },
    ]);
    expect(screen.queryByRole("button", { name: /插入正文/ })).toBeNull();
  });
});
