"use client";

import { useState } from "react";
import { FileInput } from "@/components/ui/file-input";

/**
 * 品牌素材上传文件输入（M9.5 LOGO 版起，M11 泛化给 Hero 共用）：选文件即校验大小与类型，
 * 不合格直接清空选择并就地提示——替代「提交后才报错、让管理员线下跑脚本」的断裂链路
 * （服务端魔数 + 大小 + 像素校验仍兜底）。
 */
export function BrandFileInput({
  maxBytes,
  hint,
}: {
  maxBytes: number;
  /** 超限提示里的尺寸建议，如「建议 224×224 内」 */
  hint: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const kb = Math.round(maxBytes / 1024);
  const limit = kb >= 1024 ? `${Math.round(kb / 1024)}MB` : `${kb}KB`;
  return (
    <label className="grid max-w-full min-w-0 flex-[1_1_18rem] gap-1 text-sm">
      PNG 文件（≤{limit}）
      <FileInput
        name="file"
        accept="image/png"
        required
        aria-invalid={error !== null}
        showSelection={false}
        onChange={(e) => {
          const f = e.currentTarget.files?.[0];
          if (!f) {
            setError(null);
            setFileName(null);
            return;
          }
          if (f.type !== "image/png") {
            setError(`「${f.name}」不是 PNG（仅支持 PNG，文件魔数在服务端二次校验）`);
            e.currentTarget.value = "";
            setFileName(null);
            return;
          }
          if (f.size > maxBytes) {
            setError(
              `「${f.name}」约 ${Math.round(f.size / 1024)}KB 超过 ${limit}——请压缩后重试（${hint}）`,
            );
            e.currentTarget.value = "";
            setFileName(null);
            return;
          }
          setError(null);
          setFileName(f.name);
        }}
      />
      {error ? (
        <span role="alert" className="min-w-0 text-xs [overflow-wrap:anywhere] text-destructive">
          {error}
        </span>
      ) : fileName ? (
        <span
          className="min-w-0 text-xs [overflow-wrap:anywhere] text-muted-foreground"
          title={fileName}
        >
          已选 {fileName}
        </span>
      ) : null}
    </label>
  );
}
