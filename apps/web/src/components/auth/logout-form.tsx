"use client";

import { clearAllDrafts } from "@/components/editor/draft";

/**
 * 退出登录表单（M6.3 §6）：提交时先清除浏览器里的编辑器草稿，再由 Server Action 退出会话。
 * 草稿只是个人便利，但退出意味着换人或离开，不应把上一个人的未发送内容留在这台机器上。
 */
export function LogoutForm({
  action,
  children,
}: {
  action: (formData: FormData) => Promise<void>;
  children: React.ReactNode;
}) {
  return (
    <form action={action} onSubmit={() => clearAllDrafts()}>
      {children}
    </form>
  );
}
