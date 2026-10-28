// @vitest-environment jsdom
/**
 * 表格上下文工具条（M10.8 Step 3）：光标在表格内才出现；增删行列后的 Markdown 仍是合法 GFM 表格。
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EditorShell } from "./editor-shell";

const hidden = (c: HTMLElement) => c.querySelector<HTMLInputElement>('input[name="source"]')!;
const press = async (name: string) => {
  await act(async () => {
    screen.getByRole("button", { name }).click();
  });
};
const tab = async () => {
  await act(async () => {
    fireEvent.keyDown(screen.getByRole("textbox", { name: "正文" }), { key: "Tab" });
  });
};
/** 表格的数据行数（不含表头与分隔行） */
const bodyRows = (md: string) =>
  md.split("\n").filter((l) => l.startsWith("|") && !/-{3,}/.test(l)).length - 1;
const colCount = (md: string) =>
  (md.split("\n").find((l) => l.startsWith("|")) ?? "").split("|").length - 2;

async function mountWithTable() {
  const r = render(
    <EditorShell
      name="source"
      initialSource=""
      draftKey={null}
      restoreDraft={false}
      label="正文"
    />,
  );
  await screen.findByRole("toolbar", { name: "编辑工具栏" });
  await press("插入表格"); // 插入后光标在第一个单元格（表头行）
  await screen.findByRole("toolbar", { name: "表格工具" });
  await waitFor(() => expect(bodyRows(hidden(r.container).value)).toBe(2));
  return r;
}

describe("表格工具条", () => {
  it("光标不在表格内时不出现", async () => {
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
    expect(screen.queryByRole("toolbar", { name: "表格工具" })).toBeNull();
  });

  it("表头行：不能在上方插行、不能删除行（会让表头语义错位）", async () => {
    await mountWithTable();
    expect(screen.getByRole("button", { name: "在上方插入行" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "删除当前行" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "在下方插入行" })).toBeEnabled();
  });

  it("下方插行 / 右侧插列 / 左侧插列：行列数增加", async () => {
    const { container } = await mountWithTable();
    await press("在下方插入行");
    await waitFor(() => expect(bodyRows(hidden(container).value)).toBe(3));
    await press("在右侧插入列");
    await waitFor(() => expect(colCount(hidden(container).value)).toBe(4));
    await press("在左侧插入列");
    await waitFor(() => expect(colCount(hidden(container).value)).toBe(5));
  });

  it("删除列：列数减少；删除数据行：行数减少", async () => {
    const { container } = await mountWithTable();
    await press("删除当前列");
    await waitFor(() => expect(colCount(hidden(container).value)).toBe(2));
    // Tab 走到第二行（2 列表头：Tab×2 进入第一个数据行）
    await tab();
    await tab();
    await waitFor(() => expect(screen.getByRole("button", { name: "删除当前行" })).toBeEnabled());
    await press("删除当前行");
    await waitFor(() => expect(bodyRows(hidden(container).value)).toBe(1));
  });

  it("删除整个表格：Markdown 不再有表格，工具条消失", async () => {
    const { container } = await mountWithTable();
    await press("删除整个表格");
    await waitFor(() => expect(hidden(container).value).not.toContain("|"));
    expect(screen.queryByRole("toolbar", { name: "表格工具" })).toBeNull();
  });
});
