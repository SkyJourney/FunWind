"use client";

import { useState } from "react";

/**
 * 导航/友链条目化编辑器（M9.5）：每行「名称 + 路径」两个输入 + 删行/加行按钮。
 * 提交时序列化回既有的「label,href\n」单字符串（hidden input），存储格式与 Server Action 不变。
 */
export function ChromeRowsEditor({
  name,
  initialRows,
  hrefPlaceholder,
  addLabel,
}: {
  name: string;
  initialRows: { label: string; href: string }[];
  hrefPlaceholder: string;
  addLabel: string;
}) {
  const [rows, setRows] = useState<{ label: string; href: string }[]>(
    initialRows.length > 0 ? initialRows : [],
  );
  const serialize = (rs: { label: string; href: string }[]) =>
    rs
      .filter((r) => r.label.trim().length > 0 || r.href.trim().length > 0)
      .map((r) => `${r.label.trim()},${r.href.trim()}`)
      .join("\n");

  const update = (i: number, patch: Partial<{ label: string; href: string }>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div>
      <input type="hidden" name={name} value={serialize(rows)} />
      {rows.map((r, i) => (
        <div key={i} className="mb-1.5 flex gap-1.5">
          <input
            value={r.label}
            onChange={(e) => update(i, { label: e.target.value })}
            placeholder={`名称${i + 1}`}
            aria-label={`第 ${i + 1} 行名称`}
            className="w-24 rounded-lg border bg-background px-2 py-1 text-xs"
          />
          <input
            value={r.href}
            onChange={(e) => update(i, { href: e.target.value })}
            placeholder={hrefPlaceholder}
            aria-label={`第 ${i + 1} 行路径`}
            className="min-w-0 flex-1 rounded-lg border bg-background px-2 py-1 font-mono text-xs"
          />
          <button
            type="button"
            onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
            aria-label={`删除第 ${i + 1} 行`}
            className="rounded border px-1.5 text-xs text-muted-foreground hover:bg-accent"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => setRows((rs) => [...rs, { label: "", href: "" }])}
        className="rounded-lg border px-2.5 py-1 text-xs hover:bg-accent"
      >
        + {addLabel}
      </button>
    </div>
  );
}
