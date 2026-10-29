"use client";

import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import {
  Bold,
  Code,
  FileCode,
  Heading,
  IndentDecrease,
  Crop,
  ImagePlus,
  IndentIncrease,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Lock,
  Minus,
  Smile,
  Quote,
  Redo2,
  RemoveFormatting,
  Strikethrough,
  Table as TableIcon,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { EmojiPanel } from "./emoji-panel";
import { nextGateKey } from "./gate-keys";
import { defaultGateAttrs } from "./markdown/gate";

/** 快捷键里的修饰键：Mac 显示 ⌘，其余显示 Ctrl（编辑器只在浏览器里创建，这里可以直接读 navigator） */
const modLabel = () =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

/** 链接地址规整：没有协议且不是站内路径 / 锚点 / 邮箱的，补 https://；空串表示移除链接 */
export function normalizeHref(raw: string): string {
  const v = raw.trim();
  if (v === "") return "";
  if (/^(https?:\/\/|mailto:|\/|#)/i.test(v)) return v;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return `mailto:${v}`;
  return `https://${v}`;
}

type ToolButtonProps = Omit<
  React.ComponentProps<typeof Button>,
  "children" | "title" | "variant"
> & {
  icon: LucideIcon;
  label: string;
  shortcut?: string;
  active?: boolean;
};

/**
 * 工具栏按钮：图标 + 即时 Tooltip（名称 + 快捷键）。名称同时是 aria-label，触屏与读屏靠它；
 * 触控目标移动端不小于 44px，桌面端保持紧凑。onMouseDown 阻止默认行为：点按钮不让编辑区失焦、选区不丢。
 * 其余属性与 ref 透传给按钮：作为 `PopoverTrigger asChild` 的子元素时，开关与 aria-expanded 由 Radix 注入。
 */
export function ToolButton({
  icon: Icon,
  label,
  shortcut,
  active = false,
  disabled = false,
  onMouseDown,
  ...rest
}: ToolButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant={active ? "secondary" : "ghost"}
          aria-label={label}
          aria-pressed={rest["aria-expanded"] === undefined ? active : undefined}
          disabled={disabled}
          {...rest}
          onMouseDown={(e) => {
            e.preventDefault();
            onMouseDown?.(e);
          }}
          className="min-h-11 min-w-11 shrink-0 px-2 sm:min-h-9 sm:min-w-9"
        >
          <Icon className="size-4" aria-hidden />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut ? <span className="ml-1.5 opacity-70">{shortcut}</span> : null}
      </TooltipContent>
    </Tooltip>
  );
}

const Divider = () => <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />;

const HEADINGS: { level: 1 | 2 | 3; label: string; className: string }[] = [
  { level: 1, label: "标题 1", className: "text-lg font-bold" },
  { level: 2, label: "标题 2", className: "text-base font-bold" },
  { level: 3, label: "标题 3", className: "text-sm font-bold" },
];

/**
 * 编辑器工具栏（M6.3 第 2 步；M10.8 重做）。每个按钮都是对编辑器命令的薄包装，按下状态与可用状态都来自编辑器当前选区。
 * 分组：文本 · 块 · 插入 · 历史。图片按钮由外壳按需注入（上传需要版块上下文，见 editor-shell.tsx）。
 *
 * 插入类命令（表格 / 分隔线 / 门控块）一律先把选区折叠到末尾再插入：ProseMirror 的插入默认会替换选区，
 * 有选中文字时点击按钮会把文字吞掉（M10.8 Step 1 实测缺陷）。
 */
export function EditorToolbar({
  editor,
  onInsertGate,
  onUploadImage,
  imageDisabled = false,
  cropOn = false,
  onToggleCrop,
}: {
  editor: Editor;
  onInsertGate?: () => void;
  /** 提供时显示「上传图片」按钮：选图 → 上传 → 插入由外壳完成（上传需要版块上下文） */
  onUploadImage?: () => void;
  imageDisabled?: boolean;
  /** 「裁剪后插入」开关（与源码模式下的勾选框同一状态） */
  cropOn?: boolean;
  onToggleCrop?: () => void;
}) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      strike: e.isActive("strike"),
      code: e.isActive("code"),
      link: e.isActive("link"),
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      quote: e.isActive("blockquote"),
      codeBlock: e.isActive("codeBlock"),
      heading: HEADINGS.find((h) => e.isActive("heading", { level: h.level }))?.level ?? 0,
      inList: e.isActive("listItem"),
      // 代码块内不能加粗 / 斜体 / 链接等：置灰而不是点了没反应
      // 每个按钮用自己的可用性判断：代码标记里不允许再加粗等（Code 标记排斥其它标记），
      // 若共用一个判断，光标在行内代码里时连「行内代码」按钮自己也被置灰，就取消不了了（增删改查审计发现）。
      // 「已激活」时一律可点：点它就是取消
      canBold: e.isActive("bold") || e.can().toggleBold(),
      canItalic: e.isActive("italic") || e.can().toggleItalic(),
      canStrike: e.isActive("strike") || e.can().toggleStrike(),
      canCode: e.isActive("code") || e.can().toggleCode(),
      // 标题是块级设置，不受标记限制：只有在能转换时才可用（代码块里也可以改回标题 / 正文）
      canHeading:
        e.isActive("heading") || e.can().setHeading({ level: 1 }) || e.can().setParagraph(),
      canLink: e.can().setLink({ href: "https://example.com" }) || e.isActive("link"),
      canSink: e.can().sinkListItem("listItem"),
      canLift: e.can().liftListItem("listItem"),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });

  const chain = () => editor.chain().focus();
  /** 插入前把选区折叠到末尾，避免替换选中的文字 */
  const afterSelection = () => chain().setTextSelection(editor.state.selection.to);
  /**
   * 插入锁定内容：语法要求它只能在最外层，所以总是插在光标所在**最外层块**之后（光标在引用 / 列表 / 另一个锁定内容里也一样），
   * 不在当前位置硬塞——否则会生成语法不允许的嵌套；当前最外层块是空段落时直接替换它（避免留一个多余的空行）。
   * 插入后光标落进新块的正文里，可以直接输入。
   */
  const insertGate = () => {
    const { $to } = editor.state.selection;
    let from = $to.pos;
    let to = $to.pos;
    if ($to.depth > 0) {
      const top = $to.node(1);
      const start = $to.before(1);
      const end = $to.after(1);
      const emptyParagraph = top.type.name === "paragraph" && top.content.size === 0;
      from = emptyParagraph ? start : end;
      to = end;
    }
    const key = nextGateKey(editor.getJSON());
    chain()
      .insertContentAt(
        { from, to },
        { type: "gate", attrs: defaultGateAttrs(key), content: [{ type: "paragraph" }] },
      )
      .setTextSelection(from + 2)
      .run();
    onInsertGate?.();
  };

  const mod = modLabel();

  // 链接弹层：⌘/Ctrl+K 或点按钮打开；打开时带出当前链接地址
  const [linkOpen, setLinkOpen] = useState(false);
  const [href, setHref] = useState("");
  const onLinkOpenChange = (next: boolean) => {
    if (next) setHref((editor.getAttributes("link").href as string | undefined) ?? "");
    setLinkOpen(next);
  };
  useEffect(() => {
    const dom = editor.view.dom;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setHref((editor.getAttributes("link").href as string | undefined) ?? "");
        setLinkOpen(true);
      }
    };
    dom.addEventListener("keydown", onKey);
    return () => dom.removeEventListener("keydown", onKey);
  }, [editor]);

  const applyLink = () => {
    const url = normalizeHref(href);
    if (url === "") {
      chain().extendMarkRange("link").unsetLink().run();
    } else if (editor.state.selection.empty && !editor.isActive("link")) {
      // 没选文字：把地址本身作为链接文字插入
      chain()
        .insertContent({ type: "text", text: url, marks: [{ type: "link", attrs: { href: url } }] })
        .run();
    } else {
      chain().extendMarkRange("link").setLink({ href: url }).run();
    }
    setLinkOpen(false);
  };

  // 表情弹层：选中即插入；Shift 点击连续插入（弹层不关，也不抢走编辑区焦点）
  const [emojiOpen, setEmojiOpen] = useState(false);
  const insertEmoji = (emoji: string, keepOpen: boolean) => {
    const c = editor.chain();
    if (!keepOpen) c.focus();
    c.insertContent(emoji).run();
    if (!keepOpen) setEmojiOpen(false);
  };
  // 社区表情（M10.9）：插入行内图片节点，alt 用展示名（渲染不变，无障碍语义）
  const insertEmojiImage = (url: string, alt: string, keepOpen: boolean) => {
    const c = editor.chain();
    if (!keepOpen) c.focus();
    c.setImage({ src: url, alt }).run();
    if (!keepOpen) setEmojiOpen(false);
  };

  const headingLabel = state.heading ? `标题 ${state.heading}` : "标题";

  return (
    <TooltipProvider delayDuration={150}>
      <div
        role="toolbar"
        aria-label="编辑工具栏"
        // 移动端单行横滚（两端有渐隐提示）；桌面宽度放得下就换行显示全部按钮，不再藏在滚动条后面
        className="fw-scroll-x flex [scrollbar-width:none] flex-nowrap items-center gap-0.5 overflow-x-auto px-1.5 py-1 md:flex-wrap md:overflow-visible md:[background:none] [&::-webkit-scrollbar]:hidden"
      >
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant={state.heading ? "secondary" : "ghost"}
                  aria-label="标题"
                  aria-pressed={state.heading > 0}
                  disabled={!state.canHeading}
                  onMouseDown={(e) => e.preventDefault()}
                  className="min-h-11 min-w-11 shrink-0 gap-0.5 px-2 sm:min-h-9 sm:min-w-9"
                >
                  <Heading className="size-4" aria-hidden />
                  {state.heading ? <span className="text-xs">{state.heading}</span> : null}
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>{headingLabel}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={() => chain().setParagraph().run()}>正文</DropdownMenuItem>
            {HEADINGS.map((h) => (
              <DropdownMenuItem
                key={h.level}
                onSelect={() => chain().toggleHeading({ level: h.level }).run()}
              >
                <span className={cn(h.className)}>{h.label}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <ToolButton
          icon={Bold}
          label="加粗"
          shortcut={`${mod}B`}
          active={state.bold}
          disabled={!state.canBold}
          onClick={() => chain().toggleBold().run()}
        />
        <ToolButton
          icon={Italic}
          label="斜体"
          shortcut={`${mod}I`}
          active={state.italic}
          disabled={!state.canItalic}
          onClick={() => chain().toggleItalic().run()}
        />
        <ToolButton
          icon={Strikethrough}
          label="删除线"
          shortcut={`${mod}⇧S`}
          active={state.strike}
          disabled={!state.canStrike}
          onClick={() => chain().toggleStrike().run()}
        />
        <ToolButton
          icon={Code}
          label="行内代码"
          shortcut={`${mod}E`}
          active={state.code}
          disabled={!state.canCode}
          onClick={() => chain().toggleCode().run()}
        />
        <Popover open={linkOpen} onOpenChange={onLinkOpenChange}>
          <PopoverTrigger asChild>
            <ToolButton
              icon={LinkIcon}
              label="链接"
              shortcut={`${mod}K`}
              active={state.link}
              disabled={!state.canLink}
            />
          </PopoverTrigger>
          <PopoverContent
            onOpenAutoFocus={(e) => {
              // 焦点交给地址输入框（默认会落到弹层容器）
              e.preventDefault();
              (e.currentTarget as HTMLElement).querySelector("input")?.focus();
            }}
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              // 弹层关闭动画结束时编辑器可能已卸载（切换模式 / 离开页面）：已销毁就不再聚焦
              if (!editor.isDestroyed) editor.commands.focus();
            }}
          >
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                applyLink();
              }}
            >
              <label className="block text-xs text-muted-foreground" htmlFor="fw-link-href">
                链接地址
              </label>
              <input
                id="fw-link-href"
                type="text"
                inputMode="url"
                value={href}
                onChange={(e) => setHref(e.target.value)}
                placeholder="https://"
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus:ring-2 focus:ring-ring focus:outline-none"
              />
              <div className="flex justify-end gap-2">
                {state.link && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setHref("");
                      chain().extendMarkRange("link").unsetLink().run();
                      setLinkOpen(false);
                    }}
                  >
                    移除链接
                  </Button>
                )}
                <Button type="submit" size="sm">
                  确定
                </Button>
              </div>
            </form>
          </PopoverContent>
        </Popover>
        <ToolButton
          icon={RemoveFormatting}
          label="清除格式"
          onClick={() => chain().unsetAllMarks().clearNodes().run()}
        />

        <Divider />
        <ToolButton
          icon={List}
          label="无序列表"
          active={state.bullet}
          onClick={() => chain().toggleBulletList().run()}
        />
        <ToolButton
          icon={ListOrdered}
          label="有序列表"
          active={state.ordered}
          onClick={() => chain().toggleOrderedList().run()}
        />
        <ToolButton
          icon={IndentIncrease}
          label="增加缩进"
          shortcut="Tab"
          disabled={!state.canSink}
          onClick={() => chain().sinkListItem("listItem").run()}
        />
        <ToolButton
          icon={IndentDecrease}
          label="减少缩进"
          shortcut="⇧Tab"
          disabled={!state.canLift}
          onClick={() => chain().liftListItem("listItem").run()}
        />
        <ToolButton
          icon={Quote}
          label="引用"
          active={state.quote}
          onClick={() => chain().toggleBlockquote().run()}
        />
        <ToolButton
          icon={FileCode}
          label="代码块"
          active={state.codeBlock}
          onClick={() => chain().toggleCodeBlock().run()}
        />

        <Divider />
        {onUploadImage && (
          <ToolButton
            icon={ImagePlus}
            label="上传图片"
            disabled={imageDisabled}
            onClick={onUploadImage}
          />
        )}
        {onUploadImage && onToggleCrop && (
          <ToolButton icon={Crop} label="裁剪后插入" active={cropOn} onClick={onToggleCrop} />
        )}
        <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
          <PopoverTrigger asChild>
            <ToolButton icon={Smile} label="表情" />
          </PopoverTrigger>
          <PopoverContent
            className="w-auto p-2"
            onOpenAutoFocus={(e) => {
              // 焦点交给搜索框
              e.preventDefault();
              (e.currentTarget as HTMLElement).querySelector("input")?.focus();
            }}
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              // 弹层关闭动画结束时编辑器可能已卸载（切换模式 / 离开页面）：已销毁就不再聚焦
              if (!editor.isDestroyed) editor.commands.focus();
            }}
          >
            <EmojiPanel onPick={insertEmoji} onPickImage={insertEmojiImage} />
          </PopoverContent>
        </Popover>
        <ToolButton
          icon={TableIcon}
          label="插入表格"
          onClick={() =>
            afterSelection().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
          }
        />
        <ToolButton
          icon={Minus}
          label="分隔线"
          onClick={() => afterSelection().setHorizontalRule().run()}
        />
        <ToolButton icon={Lock} label="插入锁定内容" onClick={insertGate} />

        <Divider />
        <ToolButton
          icon={Undo2}
          label="撤销"
          shortcut={`${mod}Z`}
          disabled={!state.canUndo}
          onClick={() => chain().undo().run()}
        />
        <ToolButton
          icon={Redo2}
          label="重做"
          shortcut={`${mod}⇧Z`}
          disabled={!state.canRedo}
          onClick={() => chain().redo().run()}
        />
      </div>
    </TooltipProvider>
  );
}
