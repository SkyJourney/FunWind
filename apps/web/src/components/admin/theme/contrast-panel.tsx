"use client";

import { useState } from "react";
import { TEXT_CONTRAST_MIN } from "@/lib/theme/contrast-advisor";
import type { ColorKey } from "@/lib/theme/token-schema";
import { formatRatio, type ContrastRow } from "./contrast-rows";

/**
 * 对比度面板（M11.6 Step 3d）：当前档生效的颜色上，18 个固定配对的对比度。
 *
 * 只提示，不阻止保存（设计决策 D2）：作者可能有意为之，而且默认主题自己就有一项差 0.013。
 * 默认只列未达标的行，「显示全部」展开 18 行。两端都没被本包覆盖的未达标行标「来自默认主题」。
 * 每行两个「定位」按钮跳到前景 / 背景所在的颜色行；比值是否达标写成文字，不只靠颜色。
 */
export function ContrastPanel({
  rows,
  onJump,
}: {
  rows: readonly ContrastRow[];
  onJump: (key: ColorKey) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const failing = rows.filter((row) => !row.pass);
  const shown = showAll ? rows : failing;

  return (
    <section
      aria-label="对比度检查"
      data-testid="contrast-panel"
      className="min-w-0 space-y-2 text-xs"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className="min-w-0 flex-1 basis-40 [overflow-wrap:anywhere]">
          <span className="font-medium">对比度检查</span>
          <span className="ml-2 text-muted-foreground">
            {failing.length === 0
              ? `${rows.length} 项全部达标（≥ ${TEXT_CONTRAST_MIN}:1）`
              : `${failing.length} 项未达标，共 ${rows.length} 项（需 ≥ ${TEXT_CONTRAST_MIN}:1，只提示，不阻止保存）`}
          </span>
        </p>
        <button
          type="button"
          aria-expanded={showAll}
          onClick={() => setShowAll((value) => !value)}
          className="shrink-0 rounded-md border px-2 py-1 whitespace-nowrap hover:bg-accent"
        >
          {showAll ? "只看未达标" : "显示全部"}
        </button>
      </div>
      {shown.length > 0 && (
        <ul className="divide-y rounded-md border">
          {shown.map((row) => (
            <li
              key={row.id}
              data-testid="contrast-row"
              data-contrast-id={row.id}
              className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-2 py-1.5"
            >
              <span className="min-w-0 flex-1 basis-40 [overflow-wrap:anywhere]">{row.label}</span>
              <span className={row.pass ? "text-muted-foreground" : "font-medium text-destructive"}>
                {formatRatio(row.ratio)}:1{row.pass ? "" : " 未达标"}
              </span>
              {!row.pass && row.inherited && (
                <span className="text-muted-foreground">来自默认主题</span>
              )}
              <span className="flex shrink-0 flex-wrap gap-1.5">
                {(
                  [
                    [row.fg, row.fgLabel],
                    [row.bg, row.bgLabel],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    aria-label={`${row.label}：定位${label}`}
                    onClick={() => onJump(key)}
                    className="rounded-md border px-2 py-1 whitespace-nowrap hover:bg-accent"
                  >
                    定位{label}
                  </button>
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
