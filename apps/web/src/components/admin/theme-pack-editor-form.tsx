"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useFormStatus } from "react-dom";
import { ThemePackEditor } from "./theme-pack-editor";
import type { AssetLibraryItem } from "./theme-asset-library";
import type { SurfaceMeta } from "./theme/pack-draft";
import {
  parseThemePackSaveDraft,
  serializeThemePackSaveDraft,
  themePackSaveDraftKey,
  type ThemePackSaveDraft,
} from "./theme/pack-save-draft";
import type { ThemePackDefinition } from "@/lib/theme/surface-schema";

interface Props {
  action: (data: FormData) => Promise<void>;
  userId: number;
  packId: string;
  revision: number;
  name: string;
  description: string;
  initialDefinition: ThemePackDefinition;
  error?: string;
  saved: boolean;
  ack?: string;
  surfaces: readonly SurfaceMeta[];
  fallbackDefinition?: ThemePackDefinition;
  decorFiles: readonly { file: string; name: string }[];
  decorUsage?: ReadonlyMap<string, AssetLibraryItem["usage"]>;
}

const subscribeNothing = () => () => {};

/** 将完整保存快照限制在账号与主题包内，不依赖软导航是否保留客户端状态。 */
export function ThemePackEditorForm(props: Props) {
  return <SaveSession key={`${props.userId}:${props.packId}`} {...props} />;
}

function SaveSession(props: Props) {
  const [submission, setSubmission] = useState<{ id: string | null; generation: number }>({
    id: null,
    generation: 0,
  });
  if (props.saved && !props.error && submission.id !== null && props.ack === submission.id) {
    // 只有本次随机提交标识的服务端成功回执才能清稿；旁路刷新与旧 saved 参数都不算。
    setSubmission({ id: null, generation: submission.generation + 1 });
  }
  const submitted = (id: string) => setSubmission((previous) => ({ ...previous, id }));
  return <DraftSession key={submission.generation} {...props} submitted={submitted} />;
}

function DraftSession(props: Props & { submitted: (id: string) => void }) {
  const draftKey = themePackSaveDraftKey(props.userId, props.packId);
  const restore = Boolean(props.error) && !props.saved;
  // 快照只读取一次；后续输入不得反过来变成新的“进入页草稿”，触发编辑器重建。
  const [readStart] = useState(() => {
    let snapshot: string | null | undefined;
    return () => {
      if (snapshot === undefined) {
        try {
          snapshot = restore ? sessionStorage.getItem(draftKey) : null;
        } catch {
          snapshot = null;
        }
      }
      return snapshot;
    };
  });
  const raw = useSyncExternalStore(subscribeNothing, readStart, () => null);
  const ready = useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  );
  const parsed = raw === null ? null : parseThemePackSaveDraft(raw);
  const restored =
    parsed?.userId === props.userId && parsed.packId === props.packId ? parsed : null;

  useEffect(() => {
    if (restore) return;
    try {
      sessionStorage.removeItem(draftKey);
    } catch {
      // 存储不可用时仍可编辑；发生写入失败时在表单内提示。
    }
  }, [draftKey, restore]);

  return (
    <SaveFields
      key={raw ?? "server"}
      {...props}
      draftKey={draftKey}
      ready={ready}
      restored={restored}
    />
  );
}

function SaveFields({
  draftKey,
  ready,
  restored,
  ...props
}: Props & {
  draftKey: string;
  ready: boolean;
  restored: ThemePackSaveDraft | null;
  submitted: (id: string) => void;
}) {
  const serverDraft = (): ThemePackSaveDraft => ({
    userId: props.userId,
    packId: props.packId,
    expectedRevision: props.revision,
    name: props.name,
    description: props.description,
    definition: props.initialDefinition,
  });
  const [draft, setDraft] = useState(() => restored ?? serverDraft());
  const currentDraft = useRef(draft);
  const [loadedLatest, setLoadedLatest] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const [storageFailed, setStorageFailed] = useState(false);
  const [hasWork, setHasWork] = useState(Boolean(restored));
  const conflict =
    draft.expectedRevision !== props.revision || (props.error === "conflict" && !loadedLatest);

  const persist = useCallback(
    (value: ThemePackSaveDraft) => {
      setHasWork(true);
      try {
        sessionStorage.setItem(draftKey, serializeThemePackSaveDraft(value));
        setStorageFailed(false);
      } catch {
        setStorageFailed(true);
      }
    },
    [draftKey],
  );
  const updateDefinition = useCallback(
    (definition: ThemePackDefinition) => {
      const next = { ...currentDraft.current, definition };
      currentDraft.current = next;
      setDraft(next);
      persist(next);
    },
    [persist],
  );

  const loadLatest = () => {
    if (
      !window.confirm("放弃当前未保存的名称、说明和主题配置，载入服务端最新版本？此操作无法撤销。")
    ) {
      return;
    }
    try {
      sessionStorage.removeItem(draftKey);
    } catch {
      setStorageFailed(true);
    }
    const latest = serverDraft();
    currentDraft.current = latest;
    setDraft(latest);
    setHasWork(false);
    setLoadedLatest(true);
    setEditorKey((value) => value + 1);
  };

  return (
    <form
      action={async (data) => {
        const submissionId = crypto.randomUUID();
        data.set("submissionId", submissionId);
        props.submitted(submissionId);
        await props.action(data);
      }}
      className="max-w-full min-w-0"
      onSubmit={(event) => {
        if (!ready || conflict) {
          event.preventDefault();
          return;
        }
        // 提交前再次暂存实际负载；名称为空等失败输入也属于用户工作成果。
        const data = new FormData(event.currentTarget);
        persist({
          ...draft,
          name: String(data.get("name") ?? ""),
          description: String(data.get("description") ?? ""),
          definition: JSON.parse(String(data.get("definition"))) as ThemePackDefinition,
        });
      }}
    >
      <input type="hidden" name="id" value={props.packId} />
      <input type="hidden" name="revision" value={draft.expectedRevision} />
      {conflict && (
        <div
          role="alert"
          className="mb-4 min-w-0 space-y-2 rounded-lg border border-destructive p-3 text-sm [overflow-wrap:anywhere]"
        >
          <p>
            版本冲突：当前草稿及其原始版本 v{draft.expectedRevision} 已保留，服务端为 v
            {props.revision}。
            再次保存不会自动升级版本或覆盖他人的修改。请先复制需要保留的改动，再载入最新版本并重新编辑。
          </p>
          <button
            type="button"
            onClick={loadLatest}
            className="shrink-0 rounded-lg border px-3 py-2 text-sm whitespace-nowrap"
          >
            放弃草稿并载入最新版本
          </button>
        </div>
      )}
      {props.error && !hasWork && !loadedLatest && (
        <p role="status" className="mb-4 text-sm [overflow-wrap:anywhere]">
          未找到可恢复的完整草稿（存储可能不可用或草稿已损坏）；当前显示服务端内容。
        </p>
      )}
      {storageFailed && (
        <p role="alert" className="mb-4 text-sm [overflow-wrap:anywhere]">
          浏览器无法暂存草稿。请先复制未保存的内容；保存失败或刷新可能无法恢复。
        </p>
      )}
      <div className="mb-4 grid max-w-full min-w-0 gap-3 sm:grid-cols-2">
        {(
          [
            ["name", "主题名称", 60],
            ["description", "说明", 200],
          ] as const
        ).map(([field, label, maxLength]) => (
          <label
            key={field}
            className="grid max-w-full min-w-0 gap-1 text-sm [overflow-wrap:anywhere]"
          >
            {label}
            <input
              name={field}
              required={field === "name"}
              maxLength={maxLength}
              value={draft[field]}
              onChange={(event) => {
                const next = { ...currentDraft.current, [field]: event.target.value };
                currentDraft.current = next;
                setDraft(next);
                persist(next);
              }}
              className="max-w-full min-w-0 rounded-lg border bg-background px-3 py-2"
            />
          </label>
        ))}
      </div>
      <p className="mb-4 min-w-0 text-xs [overflow-wrap:anywhere] text-muted-foreground">
        图片底纹与内容插槽引用装饰素材池中的文件。
        <Link href="/admin/decor" className="text-primary underline">
          上传或管理装饰素材
        </Link>
        。
      </p>
      <ThemePackEditor
        key={editorKey}
        surfaces={props.surfaces}
        initialDefinition={draft.definition}
        fallbackDefinition={props.fallbackDefinition}
        decorFiles={props.decorFiles}
        decorUsage={props.decorUsage}
        onDefinitionChange={updateDefinition}
      />
      <div className="mt-4 flex min-w-0 flex-wrap gap-2">
        <SaveButton disabled={!ready || conflict} />
        <Link
          href="/admin/themes"
          className="shrink-0 rounded-lg border px-4 py-2 text-sm whitespace-nowrap hover:bg-accent"
        >
          返回列表
        </Link>
      </div>
    </form>
  );
}

function SaveButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={disabled || pending}
      className="shrink-0 rounded-lg bg-primary px-4 py-2 text-sm font-medium whitespace-nowrap text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
    >
      保存主题包
    </button>
  );
}
