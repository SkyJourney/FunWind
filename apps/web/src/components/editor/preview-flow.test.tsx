// @vitest-environment jsdom
/**
 * 预览流程（M6.3 第 4 步）：点击预览 → 请求 /api/preview → 展示净化后的结果；
 * 失败（HTTP 错误、网络异常）时给出可读提示，且不影响编辑内容。
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorShell } from "./editor-shell";

const PREVIEW_LABEL = "预览（近似，以发布后为准）";

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

function mountShell() {
  return render(
    <EditorShell
      name="source"
      initialSource="正文"
      draftKey={null}
      restoreDraft={false}
      label="正文"
    />,
  );
}

async function clickPreview() {
  await screen.findByRole("toolbar", { name: "编辑工具栏" });
  await act(async () => {
    screen.getByRole("button", { name: PREVIEW_LABEL }).click();
  });
}

describe("预览", () => {
  it("成功：请求 /api/preview 携带当前 Markdown，并展示返回的 HTML", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ html: "<p>预览结果</p>" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    mountShell();
    await clickPreview();

    const section = await screen.findByRole("region", { name: "预览" });
    expect(section).toHaveTextContent("预览结果");
    expect(section).toHaveTextContent("近似预览");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/preview",
      expect.objectContaining({ method: "POST", credentials: "same-origin" }),
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(body.source).toBe("正文");
  });

  it("请求进行中：按钮禁用并显示「预览中…」", async () => {
    let resolve!: (v: unknown) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise((r) => (resolve = r))),
    );
    mountShell();
    await clickPreview();
    expect(await screen.findByRole("button", { name: "预览中…" })).toBeDisabled();
    await act(async () => resolve({ ok: true, json: async () => ({ html: "" }) }));
    await waitFor(() => expect(screen.getByRole("button", { name: PREVIEW_LABEL })).toBeEnabled());
  });

  it("服务端返回错误状态：显示可读提示，不展示预览区", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 429 })),
    );
    mountShell();
    await clickPreview();
    expect(await screen.findByText("预览暂时不可用，请稍后再试。")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "预览" })).toBeNull();
  });

  it("网络异常：显示可读提示，编辑内容保持不变", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      }),
    );
    const { container } = mountShell();
    await clickPreview();
    expect(await screen.findByText("预览暂时不可用，请稍后再试。")).toBeInTheDocument();
    expect(container.querySelector<HTMLInputElement>('input[name="source"]')!.value).toBe("正文");
  });

  it("再次预览会清除上一次的错误", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ html: "<p>恢复</p>" }) });
    vi.stubGlobal("fetch", fetchMock);
    mountShell();
    await clickPreview();
    expect(await screen.findByText("预览暂时不可用，请稍后再试。")).toBeInTheDocument();
    await clickPreview();
    expect(await screen.findByText("恢复")).toBeInTheDocument();
    expect(screen.queryByText("预览暂时不可用，请稍后再试。")).toBeNull();
  });
});
