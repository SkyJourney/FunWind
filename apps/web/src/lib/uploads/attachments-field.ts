/**
 * 表单 `attachments` 隐藏字段的解析（M6.4d1）。字段值是 JSON 字符串：
 * `[{"fileId": 12, "gateKey": "g1" | null, "name": "字幕包.zip"}]`。
 * 字段缺失 → undefined（服务端不改动已有附件）；空字符串或 "[]" → 明确清空；结构不符 → 校验失败。
 * 放在独立文件：`"use server"` 的 Action 文件只允许导出 defineAction 的结果，schema 不能写在那里。
 */
import { z } from "zod";
import { MAX_ATTACHMENTS_PER_POST } from "./types";

const GATE_KEY_RE = /^[A-Za-z0-9_-]{1,16}$/;

export const attachmentItemSchema = z.object({
  fileId: z.number().int().positive(),
  gateKey: z.string().regex(GATE_KEY_RE).nullable(),
  name: z.string().min(1).max(255),
});

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export const attachmentsField = z.preprocess((raw) => {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.trim() === "") return [];
  return parseJson(raw);
}, z.array(attachmentItemSchema).max(MAX_ATTACHMENTS_PER_POST).optional());

export type AttachmentsField = z.infer<typeof attachmentsField>;
