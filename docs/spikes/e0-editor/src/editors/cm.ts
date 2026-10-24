import { EditorView, basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import type { Adapter } from "../types";

export const cmAdapter: Adapter = {
  id: "cm",
  label: "CodeMirror 6（源码）",
  async mount(el, md, onChange) {
    const view = new EditorView({
      parent: el,
      state: EditorState.create({
        doc: md,
        extensions: [
          basicSetup,
          markdown(),
          EditorView.lineWrapping,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChange(u.state.doc.toString());
          }),
          EditorView.theme({ "&": { fontSize: "16px" }, ".cm-content": { fontFamily: "inherit" } }),
        ],
      }),
    });
    return {
      getMarkdown: () => view.state.doc.toString(),
      setMarkdown: (next) => {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
      },
      destroy: () => view.destroy(),
    };
  },
};
