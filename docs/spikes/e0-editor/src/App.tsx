import { useEffect, useRef, useState } from "react";
import type { Adapter, CorpusItem, EditorHandle } from "./types";
import { equivalent, sameText } from "./equiv";
import { CropLab } from "./Crop";
import { ImeLab } from "./Ime";

const loaders: Record<Adapter["id"], () => Promise<Adapter>> = {
  cm: async () => (await import("./editors/cm")).cmAdapter,
  milkdown: async () => (await import("./editors/milkdown")).milkdownAdapter,
  tiptap: async () => (await import("./editors/tiptap")).tiptapAdapter,
};

let corpusCache: CorpusItem[] | null = null;
async function loadCorpus() {
  corpusCache ??= await (await fetch("/corpus.json")).json();
  return corpusCache!;
}
const tick = () => new Promise((r) => setTimeout(r, 30));

export interface BatchRow {
  id: string;
  kind: string;
  equiv: boolean;
  same: boolean;
  reason?: string;
  out?: string;
  error?: string;
}

/** 供 Playwright 批量往返：在离屏容器里挂一个编辑器，逐条「载入 → 不改 → 取回」并判定 */
async function runBatch(adapterId: Adapter["id"], limit = 100000): Promise<BatchRow[]> {
  const corpus = (await loadCorpus()).slice(0, limit);
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-9999px;top:0;width:700px;height:600px;overflow:auto";
  document.body.appendChild(host);
  const adapter = await loaders[adapterId]();
  let handle = await adapter.mount(host, "", () => {});
  const rows: BatchRow[] = [];
  for (const it of corpus) {
    try {
      await handle.setMarkdown(it.source);
      await tick();
      const out = handle.getMarkdown();
      const e = equivalent(it.source, out);
      rows.push({
        id: it.id,
        kind: it.kind,
        equiv: e.ok,
        same: sameText(it.source, out),
        reason: e.reason,
        out: e.ok ? undefined : out.slice(0, 600),
      });
    } catch (err) {
      rows.push({
        id: it.id,
        kind: it.kind,
        equiv: false,
        same: false,
        error: String((err as Error)?.message ?? err).slice(0, 200),
      });
      // 一次异常可能让编辑器状态损坏并级联到后面的样例：重建一个干净的，保证每条成绩互相独立
      try {
        await handle.destroy();
      } catch {}
      host.innerHTML = "";
      handle = await adapter.mount(host, "", () => {});
    }
  }
  await handle.destroy();
  host.remove();
  return rows;
}
/** 供 IME 自动化测试：在可见容器里挂载并把句柄挂到 window */
async function mountTest(adapterId: Adapter["id"], md: string) {
  document.getElementById("test-host")?.remove();
  const host = document.createElement("div");
  host.id = "test-host";
  host.style.cssText =
    "position:fixed;left:20px;top:20px;width:640px;height:520px;overflow:auto;background:#fff;color:#000;z-index:99999";
  document.body.appendChild(host);
  const adapter = await loaders[adapterId]();
  (window as any).__handle = await adapter.mount(host, md, () => {});
}
(window as any).__spike = { runBatch, loadCorpus, mountTest };

function firstDiff(a: string, b: string) {
  const la = a.trim().split("\n"),
    lb = b.trim().split("\n");
  for (let i = 0; i < Math.max(la.length, lb.length); i++)
    if (la[i] !== lb[i]) return `第 ${i + 1} 行\n原：${la[i] ?? "(无)"}\n后：${lb[i] ?? "(无)"}`;
  return "";
}

function EditorLab({ adapterId }: { adapterId: Adapter["id"] }) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<EditorHandle | null>(null);
  const [corpus, setCorpus] = useState<CorpusItem[]>([]);
  const [idx, setIdx] = useState(0);
  const [out, setOut] = useState("");
  const [label, setLabel] = useState("加载中…");
  const [status, setStatus] = useState<{ cls: string; text: string } | null>(null);

  useEffect(() => {
    let dead = false;
    (async () => {
      const [c, a] = await Promise.all([loadCorpus(), loaders[adapterId]()]);
      if (dead || !host.current) return;
      setCorpus(c);
      setLabel(a.label);
      handle.current = await a.mount(host.current, c[0]!.source, (md) => setOut(md));
      if (dead) {
        await handle.current.destroy();
        return;
      }
      setOut(handle.current.getMarkdown());
    })();
    return () => {
      dead = true;
      const h = handle.current;
      handle.current = null;
      Promise.resolve(h?.destroy()).catch(() => {});
      if (host.current) host.current.innerHTML = "";
    };
  }, [adapterId]);

  const load = async (i: number) => {
    const h = handle.current;
    const it = corpus[i];
    if (!h || !it) return;
    await h.setMarkdown(it.source);
    await tick();
    const rt = h.getMarkdown();
    setOut(rt);
    const e = equivalent(it.source, rt);
    const same = sameText(it.source, rt);
    setStatus(
      e.ok
        ? {
            cls: same ? "ok" : "warn",
            text: same
              ? "✔ 往返逐字相同"
              : "✔ 渲染等价，但源码被改写了\n" + firstDiff(it.source, rt),
          }
        : { cls: "bad", text: "✘ 往返后不等价：" + e.reason + "\n" + firstDiff(it.source, rt) },
    );
  };

  const kinds = [...new Set(corpus.map((c) => c.kind))];
  return (
    <div>
      <div style={{ fontSize: 13, opacity: 0.8 }}>{label}</div>
      <div className="row">
        <select value={idx} onChange={(e) => setIdx(Number(e.target.value))} style={{ flex: 1 }}>
          {kinds.map((k) => (
            <optgroup key={k} label={k}>
              {corpus.map(
                (c, i) =>
                  c.kind === k && (
                    <option key={c.id} value={i}>
                      {c.id}
                    </option>
                  ),
              )}
            </optgroup>
          ))}
        </select>
        <button className="btn" onClick={() => load(idx)}>
          载入此样例（测往返）
        </button>
      </div>
      <div className="ed">
        <div ref={host} />
      </div>
      {status && <div className={"status " + status.cls}>{status.text}</div>}
      <details>
        <summary>编辑器当前输出的 Markdown</summary>
        <textarea className="out" readOnly value={out} />
      </details>
    </div>
  );
}

const TABS = [
  ["milkdown", "Milkdown"],
  ["tiptap", "Tiptap"],
  ["cm", "CodeMirror"],
  ["crop", "裁剪"],
  ["ime", "输入法清单"],
] as const;

export function App() {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>(
    (new URLSearchParams(location.search).get("tab") as any) ?? "milkdown",
  );
  return (
    <div className="wrap">
      <h1>E0 编辑器选型测试页</h1>
      <div className="tabs">
        {TABS.map(([k, t]) => (
          <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
            {t}
          </button>
        ))}
      </div>
      {(tab === "milkdown" || tab === "tiptap" || tab === "cm") && (
        <EditorLab key={tab} adapterId={tab} />
      )}
      {tab === "crop" && <CropLab />}
      {tab === "ime" && <ImeLab />}
    </div>
  );
}
