"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
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

export function ConfirmSubmit({
  children,
  className,
  title,
  description,
  pendingText = "提交中…",
  formAction,
}: {
  children: ReactNode;
  className?: string;
  title: string;
  description: string;
  pendingText?: string;
  /** 按钮级 action 覆盖（M9.5 批量审核：一个表单多个提交目标）；requestSubmit(submitter) 时生效 */
  formAction?: string | ((formData: FormData) => void | Promise<void>);
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const confirmed = useRef(false);
  const { pending } = useFormStatus();
  useEffect(() => {
    const form = button.current?.form;
    if (!form) return;
    const onSubmit = (event: SubmitEvent) => {
      if (confirmed.current) return;
      event.preventDefault();
      setOpen(true);
    };
    form.addEventListener("submit", onSubmit);
    return () => form.removeEventListener("submit", onSubmit);
  }, []);
  return (
    <>
      <button
        ref={button}
        type="submit"
        formAction={formAction}
        className={className}
        disabled={pending}
      >
        {pending ? pendingText : children}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            button.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                取消
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                const submitter = button.current;
                if (!submitter?.form || !submitter.form.reportValidity()) {
                  setOpen(false);
                  return;
                }
                setOpen(false);
                confirmed.current = true;
                submitter.form.requestSubmit(submitter);
                confirmed.current = false;
              }}
            >
              确认
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
