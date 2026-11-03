import "server-only";
import { Paperclip } from "lucide-react";
import type { AttachmentView } from "@/lib/gates/attachments";
import { fileUrl } from "@/lib/files";
import { FileName } from "@/components/ui/file-name";
import {
  attachmentDenyReason,
  lockedAttachmentNotice,
  splitAttachments,
} from "@/lib/queries/thread-page";

/** 仅展示附件出口已按观众过滤的视图；锁定项只计数，不传入客户端或读取文件元数据。 */
export function AttachmentList({
  attachments,
  canDownload,
  isGuest,
}: {
  attachments: readonly AttachmentView[];
  canDownload: boolean;
  isGuest: boolean;
}) {
  if (attachments.length === 0) return null;
  const { open, lockedCount } = splitAttachments(attachments);
  return (
    <div className="mt-4 grid max-w-full min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-2 border-t pt-3">
      <Paperclip className="mt-1 size-4 shrink-0 text-muted-foreground" />
      <div className="flex max-w-full min-w-0 flex-wrap gap-2">
        {open.map((a) => {
          const content = (
            <>
              <Paperclip className="size-3.5 shrink-0" aria-hidden />
              <FileName name={a.originalName} className="line-clamp-2 flex-1" />
              <span className="shrink-0 text-muted-foreground">
                （{canDownload ? `${a.downloads} 次下载` : attachmentDenyReason(isGuest)}）
              </span>
            </>
          );
          return canDownload ? (
            <a
              key={a.id}
              href={fileUrl(a.storageKey)}
              className="inline-flex max-w-full min-w-0 flex-[1_1_16rem] items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-accent"
            >
              {content}
            </a>
          ) : (
            <span
              key={a.id}
              className="inline-flex max-w-full min-w-0 flex-[1_1_16rem] items-center gap-1 rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground"
            >
              {content}
            </span>
          );
        })}
        {lockedCount > 0 && (
          <span
            data-testid="locked-attachments"
            className="inline-flex max-w-full min-w-0 flex-[1_1_12rem] items-center gap-1 rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground"
          >
            {lockedAttachmentNotice(lockedCount)}
          </span>
        )}
      </div>
    </div>
  );
}
