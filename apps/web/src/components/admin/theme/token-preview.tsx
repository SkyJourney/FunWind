import type { CSSProperties } from "react";
import type { ColorMode } from "@/lib/theme/token-base";
import { TOKEN_PREVIEW_ATTR, previewTokenVars } from "@/lib/theme/token-preview";
import type { TokenSet } from "@/lib/theme/token-schema";

const SHADOW_CLASSES = ["shadow-1", "shadow-2", "shadow-3"] as const;
const RADIUS_CLASSES = ["rounded-sm", "rounded-md", "rounded-lg", "rounded-xl"] as const;
const RADIUS_NAMES = ["sm", "md", "lg", "xl"] as const;

/**
 * 全站语义令牌的预览（M11.6 Step 3d）：一组有代表性的控件，渲染的是**当前草稿**，不是已保存的版本。
 *
 * 容器自己带全量变量（见 lib/theme/token-preview.ts），不依赖从后台页面继承，
 * 所以后台页面是深色时，「浅色档」预览仍然是浅色。
 *
 * 这里全部用朴素标记，只引用令牌变量，不用 Button / Badge / Input 这些共享组件：
 * 它们带 `dark:` 写法，而 `dark:` 靠祖先 `[data-mode="dark"]` 匹配，页面是深色时会把浅色档预览带歪。
 * 代价是预览不覆盖那些组件自己的细节。样例是装饰性的，对读屏隐藏；说明文字不隐藏。
 */
export function TokenPreview({ mode, set }: { mode: ColorMode; set: TokenSet | undefined }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <p className="text-xs text-muted-foreground">
        预览 · {mode === "light" ? "浅色档" : "深色档"}草稿，不受后台页面明暗影响
      </p>
      <div
        aria-hidden="true"
        data-testid="token-preview"
        data-preview-mode={mode}
        {...{ [TOKEN_PREVIEW_ATTR]: "" }}
        style={{ ...(previewTokenVars(mode, set) as CSSProperties), colorScheme: mode }}
        className="min-w-0 space-y-2 rounded-lg border bg-background p-3 text-xs text-foreground"
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="rounded-md bg-primary px-2.5 py-1 text-primary-foreground">主按钮</span>
          <span className="rounded-md bg-secondary px-2.5 py-1 text-secondary-foreground">
            次按钮
          </span>
          <span className="rounded-md bg-accent px-2.5 py-1 text-accent-foreground">强调</span>
          <span className="rounded-md bg-destructive px-2.5 py-1 text-destructive-foreground">
            危险
          </span>
          <span className="rounded-md border px-2.5 py-1">描边</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <span className="rounded-md border border-primary/30 bg-primary/10 px-2 py-1 text-primary">
            提示
          </span>
          <span className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-destructive">
            错误
          </span>
          <span className="rounded-md border border-success/30 bg-success/10 px-2 py-1 text-success">
            成功
          </span>
          <span className="rounded-md border border-warning/30 bg-warning/10 px-2 py-1 text-warning">
            警告
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="rounded-full bg-secondary px-2 py-0.5 text-secondary-foreground">
            徽标
          </span>
          <span className="rounded-full bg-accent px-2 py-0.5 text-accent-foreground">徽标</span>
          <span className="text-muted-foreground">次要文字</span>
          <span className="text-info">信息色</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {SHADOW_CLASSES.map((shadow, index) => (
            <span
              key={shadow}
              className={`grid h-8 w-12 place-items-center rounded-lg border bg-card text-card-foreground ${shadow}`}
            >
              {index + 1}
            </span>
          ))}
          {RADIUS_CLASSES.map((radius, index) => (
            <span
              key={radius}
              className={`grid h-8 w-8 place-items-center border bg-card text-card-foreground ${radius}`}
            >
              {RADIUS_NAMES[index]}
            </span>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-display text-base font-semibold">Aa 标题</span>
          <span className="min-w-0 flex-1 basis-24 rounded-md border border-input bg-background px-2 py-1 text-muted-foreground ring-2 ring-ring/50">
            输入框
          </span>
        </div>
        <div className="flex items-stretch gap-2">
          <span className="h-9 w-14 shrink-0 rounded-md border bg-[image:var(--gradient-brand)]" />
          <div className="forum-card-band relative flex min-w-0 flex-1 overflow-hidden rounded-xl border bg-card text-card-foreground">
            <div className="forum-card-band__img relative w-[var(--band-width)] shrink-0 bg-[image:var(--gradient-brand)]" />
            <span className="min-w-0 flex-1 truncate p-2">板块卡</span>
          </div>
        </div>
      </div>
    </div>
  );
}
