"use client";

import { useState } from "react";
import { applySkin, EMOJI_CATEGORIES, searchEmoji, SKIN_TONES } from "@/lib/emoji/curated";
import { pushRecent, readRecent, readSkin, writeSkin } from "@/lib/emoji/recent";
import { cn } from "@/lib/utils";

/**
 * 表情面板（M10.8 Step 7）：搜索 + 分类页签 + 最近使用 + 肤色。内置 Unicode 精选 emoji，永远存在。
 * 面板只负责选择：选中后把最终字符交给 onPick（Shift 点击 = 连续插入，面板不关）。
 * 数据来源做成「页签」的一种：M10.9 接入旧版表情集与站长自定义表情时，只增数据源，不改这里的交互。
 *
 * 个人偏好（最近使用、肤色）读自 localStorage。本组件只在弹层打开时才挂载（浏览器端），
 * 所以在 useState 初始化里读存储不会引起服务端渲染不一致。
 */
export function EmojiPanel({ onPick }: { onPick: (emoji: string, keepOpen: boolean) => void }) {
  const [recent, setRecent] = useState<string[]>(() => readRecent());
  const [tone, setTone] = useState<number>(() => readSkin());
  const [tab, setTab] = useState<string>(() => (readRecent().length > 0 ? "recent" : "smileys"));
  const [query, setQuery] = useState("");

  const searching = query.trim() !== "";
  const results = searching ? searchEmoji(query) : [];
  const category = EMOJI_CATEGORIES.find((c) => c.id === tab);

  const pick = (emoji: string, shift: boolean) => {
    setRecent(pushRecent(emoji));
    onPick(emoji, shift);
  };

  const cell = (emoji: string, label: string) => (
    <button
      key={emoji + label}
      type="button"
      role="gridcell"
      aria-label={label}
      title={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => pick(emoji, e.shiftKey)}
      className="flex size-9 items-center justify-center rounded-md text-xl hover:bg-accent focus-visible:bg-accent focus-visible:outline-none sm:size-8"
    >
      {emoji}
    </button>
  );

  const tabs = [
    ...(recent.length > 0 ? [{ id: "recent", label: "最近使用", icon: "🕘" }] : []),
    ...EMOJI_CATEGORIES.map((c) => ({ id: c.id, label: c.label, icon: c.icon })),
  ];

  return (
    <div className="w-[min(21rem,calc(100vw-2.5rem))] space-y-2">
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="搜索表情，如「大笑」「点赞」"
        aria-label="搜索表情"
        className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus:ring-2 focus:ring-ring focus:outline-none"
      />
      {!searching && (
        <div role="tablist" aria-label="表情分类" className="flex gap-0.5 overflow-x-auto pb-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              aria-label={t.label}
              title={t.label}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setTab(t.id)}
              className={cn(
                "flex size-9 shrink-0 items-center justify-center rounded-md text-lg hover:bg-accent sm:size-8",
                tab === t.id && "bg-secondary",
              )}
            >
              {t.icon}
            </button>
          ))}
        </div>
      )}
      <div
        role="grid"
        aria-label={searching ? "搜索结果" : (tabs.find((t) => t.id === tab)?.label ?? "表情")}
        className="grid max-h-56 grid-cols-8 content-start gap-0.5 overflow-y-auto"
      >
        {searching ? (
          results.length > 0 ? (
            results.map((it) => cell(applySkin(it, tone), it.name))
          ) : (
            <p className="col-span-8 py-6 text-center text-sm text-muted-foreground">
              没有找到相关表情
            </p>
          )
        ) : tab === "recent" ? (
          recent.map((e) => cell(e, e))
        ) : (
          category?.items.map((it) => cell(applySkin(it, tone), it.name))
        )}
      </div>
      <div className="flex items-center gap-1 border-t pt-2" role="radiogroup" aria-label="肤色">
        <span className="pr-1 text-xs text-muted-foreground">肤色</span>
        {SKIN_TONES.map((t, i) => (
          <button
            key={t.label}
            type="button"
            role="radio"
            aria-checked={tone === i}
            aria-label={t.label}
            title={t.label}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setTone(i);
              writeSkin(i);
            }}
            className={cn(
              "flex size-7 items-center justify-center rounded-md text-base hover:bg-accent",
              tone === i && "bg-secondary ring-1 ring-ring",
            )}
          >
            {t.swatch}
          </button>
        ))}
      </div>
    </div>
  );
}
