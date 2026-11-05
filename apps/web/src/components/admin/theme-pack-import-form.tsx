"use client";

import { useState, type FormEvent } from "react";
import { FileInput } from "@/components/ui/file-input";

/** 同源上传主题 ZIP；正常启用脚本时用 fetch 避免整页跨域式表单导航。 */
export function ThemePackImportForm() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const form = event.currentTarget;
    const data = new FormData(form);
    void fetch(form.action, { method: "POST", body: data, credentials: "same-origin" })
      .then((response) => {
        if (response.redirected && new URL(response.url).origin === window.location.origin) {
          window.location.assign(response.url);
          return;
        }
        setError("导入请求未完成，请检查权限或素材文件后重试。");
      })
      .catch(() => setError("导入请求失败，请重试。"))
      .finally(() => setPending(false));
  }

  return (
    <form
      action="/admin/themes/import"
      method="post"
      encType="multipart/form-data"
      onSubmit={submit}
      className="mt-3 flex flex-wrap items-end gap-3"
      data-testid="theme-package-import"
    >
      <label className="grid gap-1 text-sm">
        新包 id
        <input
          name="id"
          required
          maxLength={32}
          pattern="[a-z0-9][a-z0-9_-]{1,31}"
          placeholder="如：paper-warm-import"
          className="w-52 rounded-lg border bg-background px-3 py-2 text-sm"
        />
      </label>
      {/* 文件框用项目的 FileInput：限制在父容器内，选择后完整文件名另行展示；裸的 type=file 在窄屏会按自身 321px 撑出整页 */}
      <label className="grid max-w-full min-w-0 flex-[1_1_18rem] gap-1 text-sm">
        主题包 ZIP 文件
        <FileInput name="archive" required accept=".zip,application/zip" />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-accent disabled:cursor-wait disabled:opacity-60"
      >
        {pending ? "校验与导入中…" : "导入主题包"}
      </button>
      {error && (
        <p role="alert" className="w-full text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
