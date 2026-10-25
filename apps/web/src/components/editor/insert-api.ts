/**
 * 编辑器对外的插入能力（M6.4d2）：外壳通过它把上传得到的图片插入当前模式的编辑器。
 * 富文本与源码模式各实现一份；isComposing 为真（输入法组合中）时外壳必须延后插入，否则会打断组合输入。
 */
export interface InsertApi {
  /** 在光标处插入一张图片（富文本为图片节点，源码为 Markdown 图片语法） */
  insertImage(url: string): void;
  /** 输入法组合进行中（拼音等未确定的字符） */
  isComposing(): boolean;
}
