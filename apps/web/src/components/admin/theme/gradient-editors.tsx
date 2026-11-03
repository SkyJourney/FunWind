import type { GradientStop } from "@/lib/theme/surface-schema";

export function GradientAngleEditor({
  angle,
  onChange,
}: {
  angle: number;
  onChange: (angle: number) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      角度
      <input
        type="range"
        min={0}
        max={359}
        value={angle}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="w-10 text-xs tabular-nums">{angle}°</span>
    </label>
  );
}

export function GradientStopsEditor({
  label,
  addLabel,
  stops,
  onChange,
}: {
  label: string;
  addLabel: string;
  stops: GradientStop[];
  onChange: (stops: GradientStop[]) => void;
}) {
  return (
    <div className="space-y-2">
      {stops.map((stop, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-xs text-muted-foreground">
            {label}色标 {index + 1}
          </span>
          <input
            aria-label={`${label}色标 ${index + 1} 颜色`}
            type="color"
            value={stop.color}
            onChange={(event) =>
              onChange(
                stops.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, color: event.target.value } : item,
                ),
              )
            }
            className="h-8 w-14 rounded border"
          />
          <label className="flex items-center gap-1 text-xs">
            透明度
            <input
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={stop.alpha}
              onChange={(event) =>
                onChange(
                  stops.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, alpha: Number(event.target.value) } : item,
                  ),
                )
              }
              className="w-16 rounded border bg-background px-1 py-0.5"
            />
          </label>
          <label className="flex items-center gap-1 text-xs">
            位置
            <input
              type="number"
              min={0}
              max={100}
              step={1}
              value={stop.position}
              onChange={(event) =>
                onChange(
                  stops.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, position: Number(event.target.value) } : item,
                  ),
                )
              }
              className="w-16 rounded border bg-background px-1 py-0.5"
            />
          </label>
          {stops.length > 2 && (
            <button
              type="button"
              aria-label={`删除${label}色标 ${index + 1}`}
              onClick={() => onChange(stops.filter((_, itemIndex) => itemIndex !== index))}
              className="rounded border px-2 py-1 text-xs hover:bg-accent"
            >
              删除
            </button>
          )}
        </div>
      ))}
      {stops.length < 8 && (
        <button
          type="button"
          onClick={() => onChange([...stops, { color: "#ffffff", alpha: 1, position: 100 }])}
          className="rounded border px-2 py-1 text-xs hover:bg-accent"
        >
          {addLabel}
        </button>
      )}
    </div>
  );
}
