"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import {
  readDraft,
  removeDraft,
  stageDraft,
  stagedKey,
  writeDraft,
} from "@/components/editor/draft";
import { UploadError, uploadFile } from "./upload-client";

/**
 * 附件面板（M6.4d2）：上传下载附件、移除、为每个附件选择归属（公开 / 某个门控）。
 * 提交时以隐藏字段 attachments（JSON）随表单发送；服务端按 registerPostFiles 校验归属与门控。
 * 草稿：列表随编辑即存到 `${draftKey}:attachments`，提交时暂存（与正文相同），失败跳回时从暂存恢复。
 */

export interface AttachmentItem {
  fileId: number;
  name: string;
  sizeBytes: number;
  gateKey: string | null;
}

const MAX_ATTACHMENTS = 20;
const attachmentsKey = (draftKey: string) => `${draftKey}:attachments`;
const noopSubscribe = () => () => {};

function parseItems(raw: string): AttachmentItem[] | null {
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return null;
    return list.flatMap((x) => {
      const o = x as Partial<AttachmentItem>;
      return typeof o.fileId === "number" && typeof o.name === "string"
        ? [
            {
              fileId: o.fileId,
              name: o.name,
              sizeBytes: Number(o.sizeBytes) || 0,
              gateKey: typeof o.gateKey === "string" ? o.gateKey : null,
            },
          ]
        : [];
    });
  } catch {
    return null;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function AttachmentPanel({
  forumId,
  gateKeys,
  initial,
  draftKey,
  restoreDraft,
  recoverStaged = false,
  onPendingChange,
}: {
  forumId: number;
  /** 正文里显式写出 key 的门控（归属下拉只列这些） */
  gateKeys: readonly string[];
  /** 服务端给出的现有附件（编辑页）；空数组为新帖 */
  initial: readonly AttachmentItem[];
  draftKey: string | null;
  /** 失败跳回后为 true：从提交前的暂存恢复列表 */
  restoreDraft: boolean;
  /** 编辑冲突跳回：暂存的是作者提交失败时的列表，与服务端不同则提示恢复或丢弃（不自动覆盖最新版本） */
  recoverStaged?: boolean;
  onPendingChange?: (delta: number) => void;
}) {
  const stagedKeyValue = draftKey !== null ? stagedKey(attachmentsKey(draftKey)) : null;
  // 恢复值只在客户端读取（服务端快照为空）；恢复后以新的 key 重新挂载内部编辑器
  const staged = useSyncExternalStore(
    noopSubscribe,
    () =>
      stagedKeyValue !== null && (restoreDraft || recoverStaged) ? readDraft(stagedKeyValue) : null,
    () => null,
  );
  const [recovered, setRecovered] = useState(false);
  const [decided, setDecided] = useState(false);

  // 普通进入时暂存键已过期（只有失败或冲突跳回才读取它），清掉以免成功发布后的列表残留
  useEffect(() => {
    if (stagedKeyValue === null || restoreDraft || recoverStaged) return;
    removeDraft(stagedKeyValue);
  }, [stagedKeyValue, restoreDraft, recoverStaged]);

  const stagedItems = staged !== null ? parseItems(staged) : null;
  const offerRecovery =
    !restoreDraft &&
    recoverStaged &&
    !decided &&
    stagedItems !== null &&
    sameItems(stagedItems, initial) === false;
  const useStaged = restoreDraft || recovered ? staged : null;
  const seed = useStaged !== null ? (parseItems(useStaged) ?? [...initial]) : [...initial];
  return (
    <>
      {offerRecovery && (
        <p
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm"
        >
          <span>发现一份未保存的附件修改（提交失败时的列表）。</span>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setRecovered(true);
              setDecided(true);
            }}
          >
            恢复附件
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              if (stagedKeyValue !== null) removeDraft(stagedKeyValue);
              setDecided(true);
            }}
          >
            丢弃
          </Button>
        </p>
      )}
      <AttachmentEditor
        key={useStaged === null ? "server" : "restored"}
        forumId={forumId}
        gateKeys={gateKeys}
        seed={seed}
        draftKey={draftKey}
        onPendingChange={onPendingChange}
      />
    </>
  );
}

/** 两份附件列表是否相同（按版块、文件与门控归属比较，顺序敏感） */
function sameItems(a: readonly AttachmentItem[], b: readonly AttachmentItem[]): boolean {
  const key = (xs: readonly AttachmentItem[]) =>
    xs.map((x) => `${x.fileId}|${x.gateKey ?? ""}|${x.name}`).join(",");
  return key(a) === key(b);
}

function AttachmentEditor({
  forumId,
  gateKeys,
  seed,
  draftKey,
  onPendingChange,
}: {
  forumId: number;
  gateKeys: readonly string[];
  seed: AttachmentItem[];
  draftKey: string | null;
  onPendingChange?: (delta: number) => void;
}) {
  const [items, setItems] = useState<AttachmentItem[]>(seed);
  const itemsRef = useRef(items);
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const hidden = useRef<HTMLInputElement>(null);

  // 门控被删除后，归属回落为公开（只在渲染时计算，不改写状态）
  const effectiveGate = (it: AttachmentItem) =>
    it.gateKey !== null && gateKeys.includes(it.gateKey) ? it.gateKey : null;

  const commit = (next: AttachmentItem[]) => {
    itemsRef.current = next;
    setItems(next);
    if (draftKey !== null) {
      const k = attachmentsKey(draftKey);
      if (next.length === 0) removeDraft(k);
      else writeDraft(k, JSON.stringify(next));
    }
  };

  // 提交即暂存（同正文的机制）：失败跳回时从暂存恢复
  useEffect(() => {
    const form = hidden.current?.form;
    if (!form || draftKey === null) return;
    const k = attachmentsKey(draftKey);
    const stage = () => stageDraft(k);
    form.addEventListener("submit", stage);
    return () => form.removeEventListener("submit", stage);
  }, [draftKey]);

  const upload = async (file: File) => {
    setError(null);
    if (itemsRef.current.length >= MAX_ATTACHMENTS) {
      setError(`一个帖子最多 ${MAX_ATTACHMENTS} 个附件。`);
      return;
    }
    setBusy((n) => n + 1);
    onPendingChange?.(1);
    try {
      const r = await uploadFile({ file, purpose: "attachment", forumId });
      commit([
        ...itemsRef.current,
        { fileId: r.fileId, name: file.name, sizeBytes: r.sizeBytes, gateKey: null },
      ]);
    } catch (e) {
      setError(e instanceof UploadError ? e.message : "上传失败，请稍后重试。");
    } finally {
      setBusy((n) => n - 1);
      onPendingChange?.(-1);
    }
  };

  const serialized = items.map((it) => ({
    fileId: it.fileId,
    gateKey: effectiveGate(it),
    name: it.name,
  }));

  return (
    <section aria-label="附件" className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">附件（{items.length}）</h3>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy > 0}
          onClick={() => input.current?.click()}
          className="min-h-11 sm:min-h-9"
        >
          添加附件
        </Button>
        <input
          ref={input}
          type="file"
          aria-label="选择附件"
          tabIndex={-1}
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void upload(file);
          }}
        />
      </div>

      {items.length > 0 && (
        <ul className="space-y-2">
          {items.map((it) => {
            const gate = effectiveGate(it);
            return (
              <li
                key={it.fileId}
                data-testid="attachment-row"
                className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm"
              >
                <span className="min-w-0 flex-1 truncate">{it.name}</span>
                <span className="text-xs text-muted-foreground">{formatSize(it.sizeBytes)}</span>
                <select
                  aria-label={`附件归属：${it.name}`}
                  value={gate ?? ""}
                  onChange={(e) =>
                    commit(
                      itemsRef.current.map((x) =>
                        x.fileId === it.fileId ? { ...x, gateKey: e.target.value || null } : x,
                      ),
                    )
                  }
                  className="min-h-11 rounded-md border border-input bg-transparent px-2 text-sm sm:min-h-9"
                >
                  <option value="">公开</option>
                  {gateKeys.map((k) => (
                    <option key={k} value={k}>
                      门控 {k}
                    </option>
                  ))}
                </select>
                {it.gateKey !== null && gate === null && (
                  <span className="text-xs text-warning">门控已不存在，将保存为公开</span>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`移除附件：${it.name}`}
                  onClick={() => commit(itemsRef.current.filter((x) => x.fileId !== it.fileId))}
                  className="min-h-11 sm:min-h-9"
                >
                  移除
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <input ref={hidden} type="hidden" name="attachments" value={JSON.stringify(serialized)} />
    </section>
  );
}
