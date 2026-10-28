"use client";

import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import {
  Bold,
  Code,
  FileCode,
  Heading,
  IndentDecrease,
  ImagePlus,
  IndentIncrease,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Lock,
  Minus,
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
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { nextGateKey } from "./gate-keys";

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

interface ToolButtonProps {
  icon: LucideIcon;
  label: string;
  shortcut?: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}

/**
 * 工具栏按钮：图标 + 即时 Tooltip（名称 + 快捷键）。名称同时是 aria-label，触屏与读屏靠它；
 * 触控目标移动端不小于 44px，桌面端保持紧凑。onMouseDown 阻止默认行为：点按钮不让编辑区失焦、选区不丢。
 */
function ToolButton({
  icon: Icon,
  label,
  shortcut,
  active = false,
  disabled = false,
  onClick,
}: ToolButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant={active ? "secondary" : "ghost"}
          aria-label={label}
          aria-pressed={active}
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onClick}
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
}: {
  editor: Editor;
  onInsertGate?: () => void;
  /** 提供时显示「上传图片」按钮：选图 → 上传 → 插入由外壳完成（上传需要版块上下文） */
  onUploadImage?: () => void;
  imageDisabled?: boolean;
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
      canMark: e.can().toggleBold(),
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
  const mod = modLabel();

  // 链接弹层：⌘/Ctrl+K 或点按钮打开；打开时带出当前链接地址
  const [linkOpen, setLinkOpen] = useState(false);
  const [href, setHref] = useState("");
  const openLink = () => {
    setHref((editor.getAttributes("link").href as string | undefined) ?? "");
    setLinkOpen(true);
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

  const headingLabel = state.heading ? `标题 ${state.heading}` : "标题";

  return (
    <TooltipProvider delayDuration={150}>
      <div
        role="toolbar"
        aria-label="编辑工具栏"
        className="flex [scrollbar-width:none] flex-nowrap items-center gap-0.5 overflow-x-auto px-1.5 py-1 [&::-webkit-scrollbar]:hidden"
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
                  disabled={!state.canMark}
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
          disabled={!state.canMark}
          onClick={() => chain().toggleBold().run()}
        />
        <ToolButton
          icon={Italic}
          label="斜体"
          shortcut={`${mod}I`}
          active={state.italic}
          disabled={!state.canMark}
          onClick={() => chain().toggleItalic().run()}
        />
        <ToolButton
          icon={Strikethrough}
          label="删除线"
          shortcut={`${mod}⇧S`}
          active={state.strike}
          disabled={!state.canMark}
          onClick={() => chain().toggleStrike().run()}
        />
        <ToolButton
          icon={Code}
          label="行内代码"
          shortcut={`${mod}E`}
          active={state.code}
          disabled={!state.canMark}
          onClick={() => chain().toggleCode().run()}
        />
        <Popover open={linkOpen} onOpenChange={setLinkOpen}>
          <PopoverAnchor asChild>
            <span className="inline-flex">
              <ToolButton
                icon={LinkIcon}
                label="链接"
                shortcut={`${mod}K`}
                active={state.link}
                disabled={!state.canLink}
                onClick={openLink}
              />
            </span>
          </PopoverAnchor>
          <PopoverContent
            onOpenAutoFocus={(e) => {
              // 焦点交给地址输入框（默认会落到弹层容器）
              e.preventDefault();
              (e.currentTarget as HTMLElement).querySelector("input")?.focus();
            }}
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              editor.commands.focus();
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
        <ToolButton
          icon={Lock}
          label="插入门控块"
          onClick={() => {
            const key = nextGateKey(editor.getJSON());
            afterSelection()
              .insertContent({
                type: "gate",
                attrs: { key, unlock: "points", price: "10" },
                content: [{ type: "paragraph" }],
              })
              .run();
            onInsertGate?.();
          }}
        />

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
