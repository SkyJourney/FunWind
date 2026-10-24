import { useState } from "react";

const ITEMS = [
  "1. 拼音输入：连续打一整句话（不要中途点候选），观察上屏是否正常、光标是否跳动",
  "2. 拼音输入：打到一半（拼音还在下划线里）按「回车」，拼音是否被原样上屏？是否额外换行？",
  "3. 选词：打『字幕组』，点候选 / 数字键选词，是否出现重复字、丢字",
  "4. 在已有文字中间插入中文（光标放在句中），是否跳到句尾",
  "5. 长按退格 / 连续退格删除中文，是否一次删多了或删不动",
  "6. 手写输入（手写键盘）写 3 个字",
  "7. 语音输入说一句话",
  "8. 粘贴一大段带换行的文字，格式是否正常",
  "9. 撤销 / 重做（Cmd+Z 或键盘撤销）",
  "10. 在『加粗 / 引用 / 列表』里输入中文，退出格式（回车两次）是否正常",
  "11.（所见即所得）在门控块里输入中文，在价格框里输入数字",
  "12. 输入过程中页面是否卡顿 / 键盘是否意外收起",
];
type S = "ok" | "bad" | "na" | undefined;

export function ImeLab() {
  const [editor, setEditor] = useState("milkdown");
  const [state, setState] = useState<Record<number, { s: S; note: string }>>({});
  const set = (i: number, p: Partial<{ s: S; note: string }>) =>
    setState((st) => ({ ...st, [i]: { s: undefined, note: "", ...st[i], ...p } }));
  const text = () =>
    [
      `设备: ${navigator.userAgent}`,
      `被测编辑器: ${editor}`,
      `时间: ${new Date().toISOString()}`,
      "",
      ...ITEMS.map(
        (t, i) =>
          `${t}\n   => ${{ ok: "正常", bad: "有问题", na: "未测" }[state[i]?.s ?? "na"] ?? "未测"}${state[i]?.note ? " | " + state[i]!.note : ""}`,
      ),
    ].join("\n");
  return (
    <div>
      <p>
        请先切到对应编辑器页签，在编辑器里按下面的清单逐项操作；回到这里记录结果，最后点「复制结果」发给我。
        <b>每个编辑器单独测一遍</b>（先选下面的被测编辑器）。
      </p>
      <div className="row">
        <label>
          被测编辑器：
          <select value={editor} onChange={(e) => setEditor(e.target.value)}>
            <option value="milkdown">Milkdown</option>
            <option value="tiptap">Tiptap</option>
            <option value="cm">CodeMirror</option>
            <option value="textarea">对照：原生 textarea</option>
          </select>
        </label>
      </div>
      {editor === "textarea" && (
        <textarea
          style={{ width: "100%", minHeight: 120, fontSize: 16 }}
          placeholder="原生 textarea（对照组：输入法的“标准表现”）"
        />
      )}
      {ITEMS.map((t, i) => (
        <div className="ime-item" key={i}>
          <div>{t}</div>
          <div className="b">
            {(["ok", "bad", "na"] as const).map((k) => (
              <button
                key={k}
                className={state[i]?.s === k ? "on" : ""}
                onClick={() => set(i, { s: k })}
              >
                {{ ok: "✔ 正常", bad: "✘ 有问题", na: "— 未测" }[k]}
              </button>
            ))}
          </div>
          <input
            type="text"
            placeholder="现象备注（可选）"
            value={state[i]?.note ?? ""}
            onChange={(e) => set(i, { note: e.target.value })}
            style={{ width: "100%", marginTop: 6, boxSizing: "border-box" }}
          />
        </div>
      ))}
      <div className="row">
        <button
          className="btn"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text());
              alert("已复制");
            } catch {
              prompt("复制下面的文字", text());
            }
          }}
        >
          复制结果
        </button>
      </div>
      <textarea className="out" readOnly value={text()} />
    </div>
  );
}
