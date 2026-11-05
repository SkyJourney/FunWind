import { ColorField } from "@/components/admin/theme/color-field";
import { NumberField } from "@/components/admin/theme/number-field";
import { OverrideRow } from "@/components/admin/theme/override-row";
import {
  BAND_FIELDS,
  GRADIENT_ANGLE_FIELD,
  SHADOW_FIELDS,
  SHADOW_LABELS,
  bandSeed,
  clearBandMaskColor,
  clearField,
  clearShadow,
  gradientSeed,
  patchBand,
  patchGradient,
  patchShadow,
  setField,
  setShadow,
  shadowSeed,
  type NumberSpec,
} from "@/components/admin/theme/token-draft";
import {
  BASE_BAND,
  BASE_FONT,
  BASE_RADIUS,
  BASE_SHADOWS,
  SHADOW_SLOTS,
  effectiveColors,
  type ColorMode,
  type ShadowSlot,
} from "@/lib/theme/token-base";
import {
  DISPLAY_FONTS,
  RADIUS_STEPS,
  type DisplayFont,
  type RadiusStep,
  type Shadow,
  type TokenSet,
} from "@/lib/theme/token-schema";

/**
 * 语义令牌编辑器的「效果」部分（M11.6 Step 3c）：圆角、展示字体、三档阴影、品牌渐变、板块卡。
 * 颜色部分在 theme-token-editor.tsx。每一项缺省 = 继承基础层；「覆盖」从基础层的值开始，「恢复继承」= 删除该键。
 * 有两处起点只是近似，点「覆盖」时外观会有细微变化：浅色阴影 1 在基础层是两层叠加而令牌只能写一层，
 * 品牌渐变在基础层是三色半透明而令牌只能写两个不透明色标。其余项的起点与基础层同值。
 *
 * 回调一律走 `edit(update)`：由父级基于最新的令牌集计算，不用渲染时捕获的值，
 * 紧挨着的两次编辑才不会互相覆盖。
 */

export type EditTokens = (update: (set: TokenSet) => TokenSet) => void;

interface Props {
  mode: ColorMode;
  set: TokenSet;
  edit: EditTokens;
}

const RADIUS_LABELS: Record<RadiusStep, string> = {
  none: "直角",
  sm: "小",
  md: "中",
  lg: "大",
  xl: "特大",
};

const FONT_LABELS: Record<DisplayFont, string> = {
  system: "系统无衬线",
  songti: "宋体",
  serif: "衬线",
};

/** 「继承默认」加若干档位的下拉；空值 = 继承 */
function InheritSelect<T extends string>({
  label,
  options,
  labels,
  value,
  inheritLabel,
  onChange,
}: {
  label: string;
  options: readonly T[];
  labels: Record<T, string>;
  value: T | undefined;
  inheritLabel: string;
  onChange: (next: T | undefined) => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
      <span className="w-full text-muted-foreground sm:w-32 sm:shrink-0">{label}</span>
      <select
        aria-label={label}
        value={value ?? ""}
        onChange={(event) => onChange(options.find((option) => option === event.target.value))}
        className="max-w-full min-w-0 rounded border bg-background px-2 py-1.5"
      >
        <option value="">{inheritLabel}</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {labels[option]}
          </option>
        ))}
      </select>
    </div>
  );
}

/** 带可见文字的数字输入。可访问名称 = 前缀 + 字段名，同一页面里各行互不重名 */
function NumLabel({
  prefix,
  spec,
  value,
  onChange,
}: {
  prefix: string;
  spec: NumberSpec<string>;
  value: number;
  onChange: (next: number) => void;
}) {
  return (
    <label className="flex items-start gap-1.5">
      <span className="shrink-0 pt-2">{spec.label}</span>
      <NumberField
        label={`${prefix} ${spec.label}`}
        value={value}
        onChange={onChange}
        min={spec.min}
        max={spec.max}
        integer={spec.integer}
        decimals={spec.decimals}
        unit={spec.unit}
      />
    </label>
  );
}

/** 带可见文字的颜色输入 */
function ColorLabel({
  prefix,
  text,
  value,
  onChange,
}: {
  prefix: string;
  text: string;
  value: string;
  onChange: (hex: string) => void;
}) {
  return (
    <label className="flex items-start gap-1.5">
      <span className="shrink-0 pt-2">{text}</span>
      <ColorField label={`${prefix} ${text}`} value={value} onChange={onChange} />
    </label>
  );
}

function describeShadow(shadow: Shadow): string {
  return `偏移 ${shadow.x}/${shadow.y}px，模糊 ${shadow.blur}px，不透明度 ${shadow.alpha}`;
}

function ShadowRow({ mode, slot, set, edit }: Props & { slot: ShadowSlot }) {
  const name = SHADOW_LABELS[slot];
  const current = set.shadows?.[slot];
  const base = BASE_SHADOWS[mode][slot];
  const shown = current ?? base;
  return (
    <OverrideRow
      label={name}
      overridden={current !== undefined}
      inherited={describeShadow(base)}
      onOverride={() => edit((s) => setShadow(s, slot, shadowSeed(mode, slot)))}
      onRestore={() => edit((s) => clearShadow(s, slot))}
    >
      {SHADOW_FIELDS.map((spec) => (
        <NumLabel
          key={spec.key}
          prefix={name}
          spec={spec}
          value={shown[spec.key]}
          onChange={(n) => edit((s) => patchShadow(s, mode, slot, { [spec.key]: n }))}
        />
      ))}
      <ColorLabel
        prefix={name}
        text="颜色"
        value={shown.color}
        onChange={(hex) => edit((s) => patchShadow(s, mode, slot, { color: hex }))}
      />
    </OverrideRow>
  );
}

function GradientRow({ mode, set, edit }: Props) {
  const current = set.brandGradient;
  const shown = current ?? gradientSeed(mode, set.colors);
  return (
    <OverrideRow
      label="品牌渐变"
      overridden={current !== undefined}
      inherited="主色、强调底、次要底的半透明三色渐变（朝右下）"
      onOverride={() => edit((s) => setField(s, "brandGradient", gradientSeed(mode, s.colors)))}
      onRestore={() => edit((s) => clearField(s, "brandGradient"))}
    >
      <NumLabel
        prefix="品牌渐变"
        spec={GRADIENT_ANGLE_FIELD}
        value={shown.angle}
        onChange={(angle) => edit((s) => patchGradient(s, mode, { angle }))}
      />
      <ColorLabel
        prefix="品牌渐变"
        text="起点色"
        value={shown.from}
        onChange={(from) => edit((s) => patchGradient(s, mode, { from }))}
      />
      <ColorLabel
        prefix="品牌渐变"
        text="终点色"
        value={shown.to}
        onChange={(to) => edit((s) => patchGradient(s, mode, { to }))}
      />
    </OverrideRow>
  );
}

function BandRow({ mode, set, edit }: Props) {
  const current = set.band;
  const shown = current ?? bandSeed();
  const card = effectiveColors(mode, set.colors).card;
  return (
    <OverrideRow
      label="板块卡"
      overridden={current !== undefined}
      inherited={`图区 ${BASE_BAND.width}rem，遮罩角度 ${BASE_BAND.angle}°，渐隐 ${BASE_BAND.fade}%，带渐隐遮罩`}
      onOverride={() => edit((s) => setField(s, "band", bandSeed()))}
      onRestore={() => edit((s) => clearField(s, "band"))}
    >
      {BAND_FIELDS.map((spec) => (
        <NumLabel
          key={spec.key}
          prefix="板块卡"
          spec={spec}
          value={shown[spec.key]}
          onChange={(n) => edit((s) => patchBand(s, { [spec.key]: n }))}
        />
      ))}
      <label className="flex items-center gap-1.5 pt-1.5">
        <input
          type="checkbox"
          checked={shown.mask}
          onChange={(event) => {
            const mask = event.target.checked;
            edit((s) => patchBand(s, { mask }));
          }}
        />
        显示渐隐遮罩
      </label>
      <label className="flex items-center gap-1.5 pt-1.5">
        <input
          type="checkbox"
          checked={shown.maskColor !== undefined}
          onChange={(event) => {
            const specify = event.target.checked;
            edit((s) => (specify ? patchBand(s, { maskColor: card }) : clearBandMaskColor(s)));
          }}
        />
        指定遮罩色
      </label>
      {shown.maskColor !== undefined && (
        <ColorLabel
          prefix="板块卡"
          text="遮罩色"
          value={shown.maskColor}
          onChange={(maskColor) => edit((s) => patchBand(s, { maskColor }))}
        />
      )}
      {!shown.mask && (
        <p className="w-full text-muted-foreground">
          遮罩关闭时，遮罩角度、渐隐宽度与遮罩色不生效。
        </p>
      )}
    </OverrideRow>
  );
}

export function TokenEffectsEditor({ mode, set, edit }: Props) {
  return (
    <>
      <fieldset className="max-w-full min-w-0 space-y-2">
        <legend className="text-xs font-medium text-muted-foreground">形状与字体</legend>
        <InheritSelect
          label="圆角"
          options={RADIUS_STEPS}
          labels={RADIUS_LABELS}
          value={set.radius}
          inheritLabel={`继承默认（${RADIUS_LABELS[BASE_RADIUS]}）`}
          onChange={(next) =>
            edit((s) =>
              next === undefined ? clearField(s, "radius") : setField(s, "radius", next),
            )
          }
        />
        <InheritSelect
          label="展示字体"
          options={DISPLAY_FONTS}
          labels={FONT_LABELS}
          value={set.displayFont}
          inheritLabel={`继承默认（${FONT_LABELS[BASE_FONT]}）`}
          onChange={(next) =>
            edit((s) =>
              next === undefined ? clearField(s, "displayFont") : setField(s, "displayFont", next),
            )
          }
        />
      </fieldset>
      <fieldset className="max-w-full min-w-0 space-y-2">
        <legend className="text-xs font-medium text-muted-foreground">阴影</legend>
        {SHADOW_SLOTS.map((slot) => (
          <ShadowRow key={slot} mode={mode} slot={slot} set={set} edit={edit} />
        ))}
      </fieldset>
      <fieldset className="max-w-full min-w-0 space-y-2">
        <legend className="text-xs font-medium text-muted-foreground">品牌渐变与板块卡</legend>
        <GradientRow mode={mode} set={set} edit={edit} />
        <BandRow mode={mode} set={set} edit={edit} />
      </fieldset>
    </>
  );
}
