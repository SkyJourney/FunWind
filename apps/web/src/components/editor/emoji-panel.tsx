"use client";

import { useEffect, useState } from "react";
import { applySkin, EMOJI_CATEGORIES, searchEmoji, SKIN_TONES } from "@/lib/emoji/curated";
import {
  fetchCommunityEmojis,
  groupNames,
  searchCommunity,
  type CommunityEmoji,
} from "@/lib/emoji/community";
import { pushRecent, readRecent, readSkin, writeSkin, type RecentEntry } from "@/lib/emoji/recent";
import { cn } from "@/lib/utils";

/**
 * 表情面板（M10.8 Step 7；M10.9 扩展）：搜索 + 分类页签 + 最近使用 + 肤色 + 社区表情。
 * 内置 Unicode 精选 emoji 永远存在；社区表情（后台管理、迁移导入）挂载时拉取一次，
 * 数据为空（零数据站点 / 接口失败）就不显示社区页签。停用的表情不在接口返回里，自然不会出现。
 *
 * 面板只负责选择：Unicode 交给 onPick，社区图片交给 onPickImage（携带 alt 展示名）。
 * Shift 点击 = 连续插入，面板不关。
 *
 * 个人偏好（最近使用、肤色）读自 localStorage。本组件只在弹层打开时才挂载（浏览器端）；
 * 社区数据经 useEffect 异步拉取（不阻塞首次渲染），浏览器专属状态不在 useState 初始化里读。
 */
export function EmojiPanel({
  onPick,
  onPickImage,
}: {
  onPick: (emoji: string, keepOpen: boolean) => void;
  /** 缺省时社区表情无法插入，社区页签不出现（如纯 Unicode 的使用场景） */
  onPickImage?: (url: string, alt: string, keepOpen: boolean) => void;
}) {
  const [recent, setRecent] = useState<RecentEntry[]>(() => readRecent());
  const [tone, setTone] = useState<number>(() => readSkin());
  const [tab, setTab] = useState<string>(() => (readRecent().length > 0 ? "recent" : "smileys"));
  const [query, setQuery] = useState("");
  const [community, setCommunity] = useState<CommunityEmoji[]>([]);

  // 社区表情只在面板打开（本组件挂载）时拉一次；失败静默为空——功能不受影响
  useEffect(() => {
    const ctrl = new AbortController();
    void fetchCommunityEmojis(ctrl.signal).then(setCommunity);
    return () => ctrl.abort();
  }, []);

  const hasCommunity = community.length > 0 && onPickImage !== undefined;
  const searching = query.trim() !== "";
  const results = searching ? searchEmoji(query) : [];
  const communityResults = searching ? searchCommunity(community, query) : [];
  const category = EMOJI_CATEGORIES.find((c) => c.id === tab);

  const pickUnicode = (emoji: string, shift: boolean) => {
    setRecent(pushRecent({ t: "c", v: emoji }));
    onPick(emoji, shift);
  };
  const pickCommunity = (item: CommunityEmoji, shift: boolean) => {
    setRecent(pushRecent({ t: "i", v: item.url }));
    onPickImage?.(item.url, item.name, shift);
  };

  const unicodeCell = (emoji: string, label: string) => (
    <button
      key={emoji + label}
      type="button"
      role="gridcell"
      aria-label={label}
      title={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => pickUnicode(emoji, e.shiftKey)}
      className="flex size-9 items-center justify-center rounded-md text-xl hover:bg-accent focus-visible:bg-accent focus-visible:outline-none sm:size-8"
    >
      {emoji}
    </button>
  );

  const communityCell = (item: CommunityEmoji) => (
    <button
      key={item.url}
      type="button"
      role="gridcell"
      aria-label={item.name}
      title={item.name}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => pickCommunity(item, e.shiftKey)}
      className="flex size-9 items-center justify-center rounded-md hover:bg-accent focus-visible:bg-accent focus-visible:outline-none sm:size-8"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={item.url}
        alt={item.name}
        width={item.width ?? 24}
        height={item.height ?? 24}
        className="max-h-7 max-w-7 object-contain"
        loading="lazy"
      />
    </button>
  );

  const tabs = [
    ...(recent.length > 0 ? [{ id: "recent", label: "最近使用", icon: "🕘" }] : []),
    ...EMOJI_CATEGORIES.map((c) => ({ id: c.id, label: c.label, icon: c.icon })),
    ...(hasCommunity ? [{ id: "community", label: "社区表情", icon: "🖼️" }] : []),
  ];

  /** 搜索结果里的社区段（有命中才显示小标题）；社区页签关闭时搜不到图片表情是预期 */
  const communitySection = (list: CommunityEmoji[], heading: string) =>
    list.length > 0 ? (
      <div className="col-span-8">
        <p className="px-0.5 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">{heading}</p>
        <div role="grid" aria-label={heading} className="grid grid-cols-8 gap-0.5">
          {list.map(communityCell)}
        </div>
      </div>
    ) : null;

  /** 社区页签：分组小标题分段平铺（组顺序即接口顺序） */
  const communityTabsContent = () => (
    <div className="max-h-56 space-y-1 overflow-y-auto">
      {groupNames(community).map((name) => (
        <div key={name}>
          <p className="px-0.5 pb-0.5 text-xs font-medium text-muted-foreground">{name}</p>
          <div role="grid" aria-label={name} className="grid grid-cols-8 gap-0.5">
            {community.filter((e) => e.group === name).map(communityCell)}
          </div>
        </div>
      ))}
    </div>
  );

  /** 最近使用里的图片条目：从社区数据反查展示名与宽高（已查不到的条目按 URL 兜底显示） */
  function communityCellFallback(url: string) {
    const item = community.find((e) => e.url === url);
    if (item) return communityCell(item);
    return (
      <button
        key={url}
        type="button"
        role="gridcell"
        aria-label={url}
        title={url}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => onPickImage?.(url, url, e.shiftKey)}
        className="flex size-9 items-center justify-center rounded-md hover:bg-accent sm:size-8"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="" width={24} height={24} className="max-h-7 max-w-7 object-contain" />
      </button>
    );
  }

  const recentCell = (entry: RecentEntry) =>
    entry.t === "c" ? unicodeCell(entry.v, entry.v) : communityCellFallback(entry.v);

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
      {searching ? (
        <div className="max-h-56 overflow-y-auto" role="grid" aria-label="搜索结果">
          <div className="grid grid-cols-8 gap-0.5">
            {results.length > 0 || communityResults.length > 0 ? (
              <>
                {results.map((it) => unicodeCell(applySkin(it, tone), it.name))}
                {communitySection(communityResults, "社区表情")}
              </>
            ) : (
              <p className="col-span-8 py-6 text-center text-sm text-muted-foreground">
                没有找到相关表情
              </p>
            )}
          </div>
        </div>
      ) : tab === "recent" ? (
        <div
          role="grid"
          aria-label="最近使用"
          className="grid max-h-56 grid-cols-8 content-start gap-0.5 overflow-y-auto"
        >
          {recent.map(recentCell)}
        </div>
      ) : tab === "community" ? (
        communityTabsContent()
      ) : (
        <div
          role="grid"
          aria-label={tabs.find((t) => t.id === tab)?.label ?? "表情"}
          className="grid max-h-56 grid-cols-8 content-start gap-0.5 overflow-y-auto"
        >
          {category?.items.map((it) => unicodeCell(applySkin(it, tone), it.name))}
        </div>
      )}
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
