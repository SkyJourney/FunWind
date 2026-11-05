"use client";

import { useRef } from "react";
import { ColorField } from "@/components/admin/theme/color-field";
import { ContrastPanel } from "@/components/admin/theme/contrast-panel";
import { contrastRows } from "@/components/admin/theme/contrast-rows";
import { jumpToTokenRow } from "@/components/admin/theme/jump-to-row";
import { OverrideRow, Swatch } from "@/components/admin/theme/override-row";
import {
  COLOR_GROUPS,
  clearColor,
  countOverrides,
  disableDark,
  enableDark,
  setColor,
  updateTokens,
} from "@/components/admin/theme/token-draft";
import { TokenEffectsEditor, type EditTokens } from "@/components/admin/theme/token-effects-editor";
import { TokenPreview } from "@/components/admin/theme/token-preview";
import type { ThemePackDefinition } from "@/lib/theme/surface-schema";
import { BASE_COLORS, type ColorMode } from "@/lib/theme/token-base";
import type { ColorKey } from "@/lib/theme/token-schema";

type Tokens = ThemePackDefinition["tokens"];

/**
 * 全站语义令牌编辑器（M11.6 Step 3c）：折叠面板，默认收起，摘要显示当前档已覆盖的项数。
 *
 * 缺省 = 继承基础层。每一项显示「继承」（只读的基础值）或「覆盖」（可编辑），
 * 点「覆盖」从继承值开始，点「恢复继承」删除该键。
 * 深色档与浅色档不对称：深色令牌需要显式「启用」（创建空集，全部继承，绝不复制浅色档的值），
 * 关闭会丢弃整个深色集，已有覆盖时先确认。
 *
 * `onChange` 接收函数形式的更新（与 React 的 setState 一致），由调用方基于最新状态计算。
 * 内层容器以 mode 为 key：切换浅 / 深时所有输入框重建，上一档没写完的文本不会留到另一档。
 *
 * Step 3d：面板顶部是令牌预览（大屏吸顶，渲染当前草稿）和对比度检查（只提示，不阻止保存）。
 * 对比度行的「定位」按钮通过 `data-token-key` 找到颜色行，滚过去并聚焦。深色未启用时两者都不显示。
 */
export function ThemeTokenEditor({
  mode,
  tokens,
  onChange,
}: {
  mode: ColorMode;
  tokens: Tokens;
  onChange: (update: (previous: Tokens) => Tokens) => void;
}) {
  const stored = tokens?.[mode];
  const darkOff = mode === "dark" && stored === undefined;
  const set = stored ?? {};
  const edit: EditTokens = (update) => onChange((previous) => updateTokens(previous, mode, update));
  const contentRef = useRef<HTMLDivElement>(null);
  const stickyRef = useRef<HTMLDivElement>(null);
  const jump = (key: ColorKey) => jumpToTokenRow(contentRef.current, key, stickyRef.current);

  const turnOffDark = () => {
    const count = countOverrides(stored);
    if (
      count > 0 &&
      !window.confirm(`关闭深色令牌会丢弃已设置的 ${count} 项覆盖，且无法撤销。继续吗？`)
    ) {
      return;
    }
    onChange(disableDark);
  };

  return (
    <details
      data-testid="theme-token-editor"
      className="max-w-full min-w-0 rounded-xl border bg-card"
    >
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium select-none sm:px-4">
        全站语义令牌
        <span className="ml-2 text-xs font-normal text-muted-foreground">
          {darkOff ? "深色未启用" : `已覆盖 ${countOverrides(stored)} 项`}
        </span>
      </summary>
      <div key={mode} ref={contentRef} className="max-w-full min-w-0 space-y-4 border-t p-3 sm:p-4">
        <p className="text-xs [overflow-wrap:anywhere] text-muted-foreground">
          这里的设置作用于整个站点（所有区域）。没有覆盖的项继承默认主题；点「覆盖」后从继承值开始修改，点「恢复继承」即删除覆盖。
        </p>
        {mode === "dark" && (
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-xs">
            <p className="min-w-0 flex-1 basis-48 [overflow-wrap:anywhere] text-muted-foreground">
              {darkOff
                ? "本主题包没有深色令牌，深色模式使用默认主题的深色样式。"
                : "未覆盖的项继承默认主题的深色样式，不会复制浅色档的设置。"}
            </p>
            <button
              type="button"
              onClick={darkOff ? () => onChange(enableDark) : turnOffDark}
              className="shrink-0 rounded-md border px-2 py-1 whitespace-nowrap hover:bg-accent"
            >
              {darkOff ? "启用深色令牌" : "关闭深色令牌"}
            </button>
          </div>
        )}
        {!darkOff && (
          <>
            {/* 吸顶只在 lg 以上：小屏上预览占去大半个屏幕，改下面的项就看不到了。top-14 = 页头 56px；
                底色不透明，滚过去的行不会从预览后面透出来 */}
            <div
              ref={stickyRef}
              className="-mx-3 bg-card px-3 pb-2 sm:-mx-4 sm:px-4 lg:sticky lg:top-14 lg:z-10 lg:border-b"
            >
              <TokenPreview mode={mode} set={stored} />
            </div>
            <ContrastPanel rows={contrastRows(mode, stored)} onJump={jump} />
            {COLOR_GROUPS.map((group) => (
              <fieldset key={group.id} className="max-w-full min-w-0 space-y-2">
                <legend className="text-xs font-medium text-muted-foreground">
                  颜色 · {group.label}
                </legend>
                {group.items.map(({ key, label }) => {
                  const override = set.colors?.[key];
                  const base = BASE_COLORS[mode][key];
                  return (
                    <OverrideRow
                      key={key}
                      label={label}
                      tokenKey={key}
                      overridden={override !== undefined}
                      inherited={
                        <>
                          <Swatch color={base} />
                          <code>{base}</code>
                        </>
                      }
                      onOverride={() => edit((s) => setColor(s, key, base))}
                      onRestore={() => edit((s) => clearColor(s, key))}
                    >
                      <ColorField
                        label={`${label}（全站）`}
                        value={override ?? base}
                        onChange={(hex) => edit((s) => setColor(s, key, hex))}
                      />
                    </OverrideRow>
                  );
                })}
              </fieldset>
            ))}
            <TokenEffectsEditor mode={mode} set={set} edit={edit} />
          </>
        )}
      </div>
    </details>
  );
}
