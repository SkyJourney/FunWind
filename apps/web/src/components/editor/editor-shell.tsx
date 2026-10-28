"use client";

import dynamic from "next/dynamic";
import { validateGates } from "@funwind/content";
import {
  memo,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ClipboardEvent,
  type RefObject,
} from "react";
import { Button } from "@/components/ui/button";
import { readDraft, removeDraft, stageDraft, stagedKey, writeDraft } from "./draft";
import { explicitGateKeys } from "./gate-keys";
import { extractInlineImages } from "./inline-images";
import type { InsertApi } from "./insert-api";
import { RichEditor } from "./rich-editor";
import { AttachmentPanel, type AttachmentItem } from "@/components/upload/attachment-panel";
import { CropDialog } from "@/components/upload/crop-dialog";
import type { Box } from "@/components/upload/crop-math";
import { ImagePicker, imageFileFromClipboard } from "@/components/upload/image-picker";
import { uploadFile } from "@/components/upload/upload-client";

/**
 * 编辑器外壳（M6.3 第 2、4、5 步）：组合所见即所得、源码模式、预览与草稿，并通过一个隐藏字段把结果交给表单。
 *
 * 数据流：
 * - 隐藏字段 `name` 的默认值是服务端给出的原文（含门控的完整源码）。编辑器的任何改动都经 sync 写入它的 DOM 值，
 *   所以未编辑时提交的就是原文（往返保护，§3）。隐藏字段不用 React 状态，SSR 与客户端首次渲染一致。
 * - 草稿：每次改动写入 localStorage（§6）；与原文相同时删除草稿。失败跳回（restoreDraft）时从草稿开始，否则清掉旧草稿。
 * - 切换模式：编辑器重新挂载，起点是当前的 Markdown。往返不等价的旧帖（forceSource）只能停留在源码模式。
 * - 预览：把当前 Markdown 发给 /api/preview，显示站点渲染器的结果（§5）。
 *
 * 源码模式（CodeMirror）通过 next/dynamic 按需加载，只在切换到源码时下载。
 */
const SourceEditor = dynamic(() => import("./source-editor"), {
  ssr: false,
  loading: () => <div className="min-h-48" aria-busy="true" />,
});

/** 草稿来自 localStorage、不会在本页内变化：订阅函数为空操作（仅为满足 useSyncExternalStore 的签名） */
const subscribeNothing = () => () => {};

/**
 * 表单里的隐藏字段（正文）。用 memo 包住：外壳因状态变化重新渲染时，这个组件的属性不变，React 不会重写它的值。
 * （若直接在外壳里渲染 defaultValue，每次外壳重渲染 React 都会把值写回原文，覆盖刚同步的草稿。）
 * SSR 仍然输出 value，无 JS 时表单携带的也是服务端原文。
 */
const HiddenSource = memo(function HiddenSource({
  name,
  initial,
  inputRef,
}: {
  name: string;
  initial: string;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  return <input ref={inputRef} type="hidden" name={name} defaultValue={initial} />;
});

export interface EditorShellProps {
  /** 表单字段名（服务端 Action 读取的字段） */
  name: string;
  /** 服务端给出的完整源码：隐藏字段的默认值，也是未编辑时提交的原文 */
  initialSource: string;
  /** 草稿键；null 表示不保存草稿 */
  draftKey: string | null;
  /** 失败跳回后为 true：恢复草稿；否则清除旧草稿 */
  restoreDraft: boolean;
  /** 编辑冲突跳回：暂存的是作者提交失败的那一版，提示恢复或丢弃（而不是本地的旧草稿） */
  recoverStaged?: boolean;
  /** 往返不等价：强制源码模式，并说明原因 */
  forceSource?: { reason: string } | null;
  /** 无障碍名称 */
  label: string;
  /** 所在版块（上传图片与附件需要）；缺省时不显示插入图片与附件 */
  forumId?: number;
  /** 编辑页：本帖现有的下载附件 */
  initialAttachments?: AttachmentItem[];
}

type Mode = "rich" | "source";

export function EditorShell({
  name,
  initialSource,
  draftKey,
  restoreDraft,
  recoverStaged = false,
  forceSource,
  label,
  forumId,
  initialAttachments,
}: EditorShellProps) {
  const hiddenRef = useRef<HTMLInputElement>(null);
  const currentRef = useRef(initialSource);

  // 起点：失败跳回时用提交前暂存的正文（见 stageDraft），否则用服务端原文。
  // 浏览器存储经 useSyncExternalStore 读取（服务端快照为空），不在 useState 初始化里读 localStorage，避免水合不一致；
  // 本地状态只保存之后的覆盖值（切换模式、接受草稿）
  const stagedStart = useSyncExternalStore(
    subscribeNothing,
    () => (restoreDraft && draftKey !== null ? readDraft(stagedKey(draftKey)) : null),
    () => null,
  );
  const [startOverride, setStart] = useState<string | null>(null);
  const start = startOverride ?? stagedStart ?? initialSource;

  // 提交即暂存草稿：监听所在表单的 submit，不改动各 composer 的提交逻辑
  useEffect(() => {
    const form = hiddenRef.current?.form;
    if (!form || draftKey === null) return;
    const stage = () => stageDraft(draftKey);
    form.addEventListener("submit", stage);
    return () => form.removeEventListener("submit", stage);
  }, [draftKey]);
  // 普通进入时若存在与原文不同的草稿：不静默覆盖，而是提示作者选择恢复或丢弃（§6）。
  // 草稿只在浏览器里：用 useSyncExternalStore 读取，服务端快照固定为 null，
  // 避免服务端渲染（无提示）与客户端首次渲染不一致而水合失败。
  // 本次访问一旦由编辑器写过草稿，就不再把它当作「进入时已有的草稿」：否则作者自己的输入会反过来触发提示
  const wroteRef = useRef(false);
  const savedDraft = useSyncExternalStore(
    subscribeNothing,
    () => {
      if (restoreDraft || draftKey === null || wroteRef.current) return null;
      const saved = readDraft(recoverStaged ? stagedKey(draftKey) : draftKey);
      return saved !== null && saved !== initialSource ? saved : null;
    },
    () => null,
  );
  // 作者已在本次进入中选择恢复或丢弃后，提示即隐藏
  const [dismissed, setDismissed] = useState(false);
  const pendingDraft = dismissed ? null : savedDraft;
  const [mode, setMode] = useState<Mode>(forceSource ? "source" : "rich");
  const [editorKey, setEditorKey] = useState(0);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [gateIssue, setGateIssue] = useState<string | null>(null);
  // 旧帖被编辑过：保存时会以编辑器格式写回（只在有原文且内容变化时提示）
  const [changedFromOriginal, setChangedFromOriginal] = useState(false);
  // 插入图片与附件（M6.4d2）
  const [gateKeys, setGateKeys] = useState<string[]>(() => explicitGateKeys(initialSource));
  // 正文里的内嵌图片：从正文派生（附件面板的「正文图片」组），同一键集合不触发重渲染
  const [inlineImages, setInlineImages] = useState(() => extractInlineImages(initialSource));
  const pickerOpen = useRef<(() => void) | null>(null);
  const [imagePending, setImagePending] = useState(0);
  const [attachPending, setAttachPending] = useState(0);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const [cropFile, setCropFile] = useState<File | null>(null);
  const richApi = useRef<InsertApi | null>(null);
  const sourceApi = useRef<InsertApi | null>(null);
  const modeRef = useRef<Mode>(mode);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  // 上传进行中禁用表单的提交按钮（按钮在外壳之外的 composer 里，经所在表单查找）
  const busy = imagePending + attachPending;
  useEffect(() => {
    const form = hiddenRef.current?.form;
    if (!form) return;
    for (const b of form.querySelectorAll<HTMLButtonElement>('button[type="submit"]'))
      b.disabled = busy > 0;
  }, [busy]);

  // 普通进入时的草稿由 pendingDraft 提示处理（恢复或丢弃）；这里不做任何静默删除

  const sync = (md: string) => {
    currentRef.current = md;
    if (hiddenRef.current) hiddenRef.current.value = md;
    // 实时提示只是提示：门控语法的权威判定在服务端 splitSource，保存时以它为准
    setGateIssue(validateGates(md)[0]?.message ?? null);
    setChangedFromOriginal(initialSource !== "" && md !== initialSource);
    setGateKeys(explicitGateKeys(md));
    const imgs = extractInlineImages(md);
    setInlineImages((prev) =>
      prev.length === imgs.length && prev.every((p, i) => p.key === imgs[i]?.key) ? prev : imgs,
    );
    // 草稿提示尚未处理（恢复或丢弃）时，不覆盖已有的草稿：编辑只改编辑器内容，草稿留给作者决定
    if (draftKey !== null && pendingDraft === null) {
      if (md === initialSource) removeDraft(draftKey);
      else {
        writeDraft(draftKey, md);
        wroteRef.current = true;
      }
    }
  };

  // 编辑器创建完成：只有起点不是服务端原文（草稿恢复、或切换模式后已有改动）时才同步。
  // 否则保持原文：编辑器的序列化与原文可能有细微差异，未编辑时绝不能让它改写内容（往返保护，§3）。
  const onCreated = (md: string) => {
    if (start !== initialSource) sync(md);
  };

  // 进入页面时清掉过期的暂存键：只有失败跳回（restoreDraft）才读取它；冲突跳回的暂存内容由上面的提示接管
  useEffect(() => {
    if (draftKey === null || restoreDraft || recoverStaged) return;
    removeDraft(stagedKey(draftKey));
  }, [draftKey, restoreDraft, recoverStaged]);

  const acceptDraft = () => {
    if (pendingDraft === null) return;
    setStart(pendingDraft);
    setDismissed(true);
    if (draftKey !== null) removeDraft(stagedKey(draftKey));
    setEditorKey((k) => k + 1);
  };

  const discardDraft = () => {
    if (draftKey !== null) {
      removeDraft(draftKey);
      removeDraft(stagedKey(draftKey));
    }
    setDismissed(true);
  };

  const switchTo = (next: Mode) => {
    setStart(currentRef.current);
    setMode(next);
    setEditorKey((k) => k + 1);
  };

  const preview = async () => {
    setPreviewBusy(true);
    setPreviewError(null);
    try {
      const res = await fetch("/api/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: currentRef.current }),
        credentials: "same-origin",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { html: string };
      setPreviewHtml(data.html);
    } catch {
      setPreviewError("预览暂时不可用，请稍后再试。");
    } finally {
      setPreviewBusy(false);
    }
  };

  // 上传完成时编辑器可能尚未就绪（例如刚切换模式、旧实例已卸载）：先排队，就绪后补插，图片不丢
  const pendingInserts = useRef<string[]>([]);
  // 插入图片：富文本与源码各有插入能力；输入法组合中延后到 compositionend，避免打断拼音等组合输入
  const insertImage = (url: string) => {
    const current = modeRef.current === "rich" ? richApi.current : sourceApi.current;
    if (current === null) {
      pendingInserts.current.push(url);
      return;
    }
    const run = () =>
      (modeRef.current === "rich" ? richApi.current : sourceApi.current)?.insertImage(url);
    if (current.isComposing()) {
      document.addEventListener("compositionend", run, { once: true });
      return;
    }
    run();
  };
  // 编辑器实例就绪（onApi）时补插排队中的图片
  const flushInserts = () => {
    for (const url of pendingInserts.current.splice(0)) insertImage(url);
  };

  // 移除正文图片：由当前模式的编辑器删掉引用（编辑器尚未就绪时忽略）
  const removeInline = (url: string) => {
    (modeRef.current === "rich" ? richApi.current : sourceApi.current)?.removeImage(url);
  };

  // preNotice：本次上传开始时要显示的提示（例如 GIF 不裁剪的说明），缺省清空
  const uploadImage = async (file: File, crop?: Box, preNotice: string | null = null) => {
    if (forumId === undefined) return;
    setImagePending((n) => n + 1);
    setUploadNotice(preNotice);
    try {
      const r = await uploadFile({ file, purpose: "inline", forumId, crop });
      insertImage(r.url);
    } catch (e) {
      setUploadNotice(e instanceof Error ? e.message : "上传失败，请稍后重试。");
    } finally {
      setImagePending((n) => n - 1);
    }
  };

  const onPickImage = (file: File, wantCrop: boolean) => {
    if (wantCrop && file.type !== "image/gif") {
      setCropFile(file);
      return;
    }
    void uploadImage(file, undefined, wantCrop ? "GIF 不支持裁剪，已直接插入。" : null);
  };

  // 粘贴截图：只拦截含图片的粘贴（捕获阶段，抢在编辑器自身的粘贴处理之前）；文本粘贴原样放行
  const onPasteCapture = (e: ClipboardEvent<HTMLDivElement>) => {
    if (forumId === undefined) return;
    const file = imageFileFromClipboard(e.clipboardData);
    if (file === null) return;
    e.preventDefault();
    e.stopPropagation();
    void uploadImage(file);
  };

  return (
    <div className="space-y-3" onPasteCapture={onPasteCapture}>
      {pendingDraft !== null && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm"
        >
          <span>发现一份未发送的草稿。</span>
          <Button type="button" size="sm" onClick={acceptDraft}>
            恢复草稿
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={discardDraft}>
            丢弃
          </Button>
        </div>
      )}

      {changedFromOriginal && (
        <p className="text-xs text-muted-foreground">
          本帖将以编辑器格式保存：文字内容保持不变，但格式写法可能与原文不同（渲染结果一致）。
        </p>
      )}

      {gateIssue && (
        <p
          role="alert"
          className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning"
        >
          锁定内容语法：{gateIssue}
        </p>
      )}

      {forceSource && (
        <p
          role="note"
          className="rounded-lg border border-info/30 bg-info/10 px-3 py-2 text-sm text-info"
        >
          {forceSource.reason}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={forceSource !== null && forceSource !== undefined && mode === "source"}
          onClick={() => switchTo(mode === "rich" ? "source" : "rich")}
        >
          {mode === "rich" ? "切换到源码" : "切换到所见即所得"}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={previewBusy} onClick={preview}>
          {previewBusy ? "预览中…" : "预览（近似，以发布后为准）"}
        </Button>
      </div>

      {mode === "rich" ? (
        <RichEditor
          key={`rich-${editorKey}`}
          initialMarkdown={start}
          label={label}
          onChange={sync}
          onReady={onCreated}
          onApi={(api) => {
            richApi.current = api;
            flushInserts();
          }}
          onUploadImage={forumId !== undefined ? () => pickerOpen.current?.() : undefined}
          imageDisabled={imagePending > 0}
        />
      ) : (
        <SourceEditor
          key={`source-${editorKey}`}
          initialMarkdown={start}
          label={label}
          onChange={sync}
          onApi={(api) => {
            sourceApi.current = api;
            flushInserts();
          }}
        />
      )}

      <HiddenSource name={name} initial={initialSource} inputRef={hiddenRef} />

      {forumId !== undefined && (
        <div className="space-y-3">
          <ImagePicker disabled={imagePending > 0} onPick={onPickImage} openRef={pickerOpen} />
          {uploadNotice && (
            <p role="alert" className="text-sm text-destructive">
              {uploadNotice}
            </p>
          )}
          <AttachmentPanel
            forumId={forumId}
            gateKeys={gateKeys}
            initial={initialAttachments ?? []}
            draftKey={draftKey}
            restoreDraft={restoreDraft}
            recoverStaged={recoverStaged}
            onPendingChange={(d) => setAttachPending((n) => n + d)}
            inlineImages={inlineImages}
            onRemoveInline={removeInline}
            onInsertImage={insertImage}
          />
        </div>
      )}
      <CropDialog
        file={cropFile}
        square={false}
        onCancel={() => setCropFile(null)}
        onConfirm={(box) => {
          const f = cropFile;
          setCropFile(null);
          if (f) void uploadImage(f, box);
        }}
      />

      {previewError && <p className="text-sm text-destructive">{previewError}</p>}
      {previewHtml !== null && (
        <section aria-label="预览" className="space-y-2 rounded-lg border bg-muted/30 p-3">
          <p className="text-xs text-muted-foreground">
            近似预览：锁定内容以占位显示，以发布后为准。
          </p>
          {/* 输出来自净化管线（lib/markdown + lib/sanitize），与正文渲染同一路径 */}
          <div className="content-md" dangerouslySetInnerHTML={{ __html: previewHtml }} />
        </section>
      )}
    </div>
  );
}
