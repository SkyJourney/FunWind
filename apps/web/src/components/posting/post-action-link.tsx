"use client";

import { useRef, useState } from "react";
import { deletePostAction, restorePostAction } from "@/app/actions/posts";
import { hidePostAction } from "@/app/admin/review/actions";
import { reportPostAction } from "@/app/actions/reports";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const actions = {
  delete: {
    label: "删除",
    description: "删除后内容不再公开，版主可以恢复。",
    action: deletePostAction,
  },
  hide: {
    label: "屏蔽",
    description: "屏蔽后普通用户不可见，作者会收到理由。",
    action: hidePostAction,
  },
  restore: {
    label: "恢复",
    description: "恢复后内容会重新对有权查看的人可见。",
    action: restorePostAction,
  },
  report: {
    label: "举报",
    description: "举报将进入版主处理队列，处理结果会通知你。",
    action: reportPostAction,
  },
};

type PostAction = (formData: FormData) => Promise<void>;

export function PostActionLink({
  postId,
  kind,
  action,
  reasonRequired = false,
}: {
  postId: number;
  kind: keyof typeof actions;
  action: PostAction;
  reasonRequired?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLAnchorElement>(null);
  const item = actions[kind];
  const reason = kind !== "delete" || reasonRequired;
  return (
    <>
      <a
        ref={trigger}
        href={`/p/${postId}/${kind}`}
        className={
          kind === "report"
            ? "text-muted-foreground hover:text-primary"
            : "text-primary hover:underline"
        }
        onClick={(event) => {
          if (
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        {item.label}
      </a>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
          className="max-h-[calc(100dvh-1rem)] overflow-y-auto max-sm:top-auto max-sm:bottom-0 max-sm:max-w-none max-sm:translate-y-0 max-sm:rounded-b-none max-sm:px-4 max-sm:pb-[calc(env(safe-area-inset-bottom)+1rem)]"
        >
          <DialogHeader>
            <DialogTitle>{item.label}内容</DialogTitle>
            <DialogDescription>{item.description}</DialogDescription>
          </DialogHeader>
          <form action={action} className="space-y-4">
            <input type="hidden" name="postId" value={postId} />
            {reason && (
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">理由（必填）</span>
                <textarea
                  name="reason"
                  required
                  maxLength={255}
                  rows={3}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-ring"
                />
              </label>
            )}
            <DialogFooter className="max-sm:flex-col-reverse max-sm:gap-2">
              <DialogClose asChild>
                <Button type="button" variant="outline" className="max-sm:w-full">
                  取消
                </Button>
              </DialogClose>
              <Button type="submit" variant="destructive" className="max-sm:w-full">
                确认{item.label}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
