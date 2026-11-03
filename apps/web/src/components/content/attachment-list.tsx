import "server-only";
import { Paperclip } from "lucide-react";
import type { AttachmentView } from "@/lib/gates/attachments";
import { fileUrl } from "@/lib/files";
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
    <div className="mt-4 flex flex-wrap gap-2 border-t pt-3">
      <Paperclip className="size-4 text-muted-foreground" />
      {open.map((a) =>
        canDownload ? (
          <a
            key={a.id}
            href={fileUrl(a.storageKey)}
            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-accent"
          >
            📎 {a.originalName}
            <span className="text-muted-foreground">（{a.downloads} 次下载）</span>
          </a>
        ) : (
          <span
            key={a.id}
            className="inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground"
          >
            📎 {a.originalName}
            <span>（{attachmentDenyReason(isGuest)}）</span>
          </span>
        ),
      )}
      {lockedCount > 0 && (
        <span
          data-testid="locked-attachments"
          className="inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground"
        >
          {lockedAttachmentNotice(lockedCount)}
        </span>
      )}
    </div>
  );
}
