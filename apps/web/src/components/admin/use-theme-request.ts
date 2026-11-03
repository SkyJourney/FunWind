"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * 主题工作区的同源 JSON 请求外壳（M11.1 Step 7）：
 * 素材库与 LOGO 管理共用——统一 pending / 成功消息 / 错误文案 / 失败回滚 / 完成后 router.refresh()。
 */

export interface ThemeRequestState {
  pending: boolean;
  message: string | null;
  error: string | null;
  fileInput: React.RefObject<HTMLInputElement | null>;
  /** 失败返回错误文案；成功返回解析后的 JSON（失败时 payload 为服务端错误体，便于展示引用清单） */
  send: (
    init: RequestInit,
    okText: string,
  ) => Promise<{ ok: true; payload: unknown } | { ok: false; payload: unknown }>;
  reset: () => void;
}

export function useThemeRequest(
  endpoint: string,
  errorText: Record<string, string>,
  fallbackError: string,
): ThemeRequestState {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = async (
    init: RequestInit,
    okText: string,
  ): Promise<{ ok: true; payload: unknown } | { ok: false; payload: unknown }> => {
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(endpoint, { credentials: "same-origin", ...init });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setError(errorText[payload.error ?? ""] ?? fallbackError);
        return { ok: false, payload };
      }
      const payload = (await response.json()) as unknown;
      setMessage(okText);
      router.refresh();
      return { ok: true, payload };
    } catch {
      setError(fallbackError);
      return { ok: false, payload: null };
    } finally {
      setPending(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  return {
    pending,
    message,
    error,
    fileInput,
    send,
    reset: () => {
      setError(null);
      setMessage(null);
    },
  };
}
