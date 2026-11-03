import type { SurfaceCapabilities } from "@/lib/theme/surface-schema";

export function ContentSlotEditor({
  contentSlot,
  decorFiles,
  onChange,
}: {
  contentSlot: SurfaceCapabilities["contentSlot"];
  decorFiles: readonly { file: string; name: string }[];
  onChange: (patch: Partial<NonNullable<SurfaceCapabilities["contentSlot"]>>) => void;
}) {
  return (
    <fieldset className="space-y-3 border-t pt-3">
      <legend className="text-xs font-medium text-muted-foreground">内容插槽</legend>
      <label className="grid gap-1 text-xs">
        装饰图片
        <select
          aria-label="内容插槽素材"
          value={contentSlot?.image ?? ""}
          onChange={(event) => onChange({ image: event.target.value || undefined })}
          className="rounded border bg-background px-2 py-1.5"
        >
          <option value="">使用区域默认内容</option>
          {decorFiles.map((file) => (
            <option key={file.file} value={file.file}>
              {file.name}
            </option>
          ))}
        </select>
      </label>
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-xs">
          图片高度
          <input
            type="number"
            min={120}
            max={480}
            step={10}
            value={contentSlot?.imageHeightPx ?? 240}
            onChange={(event) => onChange({ imageHeightPx: Number(event.target.value) })}
            className="w-20 rounded border bg-background px-2 py-1"
          />
          px
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={contentSlot?.hideText ?? false}
            onChange={(event) => onChange({ hideText: event.target.checked })}
          />
          隐藏区域自有文字
        </label>
      </div>
    </fieldset>
  );
}
