export interface EditorHandle {
  getMarkdown(): string;
  setMarkdown(md: string): Promise<void> | void;
  destroy(): Promise<void> | void;
}
export interface Adapter {
  id: "cm" | "milkdown" | "tiptap";
  label: string;
  mount(el: HTMLElement, md: string, onChange: (md: string) => void): Promise<EditorHandle>;
}
export interface CorpusItem {
  id: string;
  kind: string;
  source: string;
}
