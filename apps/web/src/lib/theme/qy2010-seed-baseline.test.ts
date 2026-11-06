// @vitest-environment node
/**
 * qy2010 种子令牌与 Step 0 冻结基线的对账（M11.6 Step 4）。
 *
 * 为什么需要它：`bootstrap.int.test` 里「补缺后等于种子」比较的是种子自己，种子里手抄错一个色值，
 * 单测和 CI 都发现不了；Step 0 冻结的浏览器计算值（`e2e-visual/fixtures/qy2010-computed.*.json`）
 * 只有本机的 `test:visual` 会读。这个测试把种子经渲染器输出的 CSS 变量，换算成浏览器计算值的写法后，
 * 与两份冻结 fixture 逐项相等，让 CI 也能发现种子里的手抄错误。Step 5 删掉 `qy2010.css` 之后，
 * 这份 fixture 是唯一的对照物。
 *
 * 换算规则（fixture 存的是浏览器规范化后的计算值，不是源码字面）：
 *  · 阴影：渲染器写 `x y blur spread rgb(r g b / a)`，浏览器算出 `rgba(r, g, b, a) x y blur spread`；
 *  · 渐变：色标的十六进制色换成 `rgb(r, g, b)`；
 *  · 圆角：`var(--fw-radius-sm)` 按 primitives.css 里的 rem 值换成 px；
 *  · 展示字体：单个标识符的族名去掉引号（`"STSong"` → `STSong`），带空格的保留；
 *  · 板块卡宽度：rem 换成 px。
 * `--band-mask-color` 种子不写，由基础层 `--band-mask-color: var(--card)` 继承；本包的 `--card`
 * 同在 `:root`，所以算出来等于种子的 `--card`（基础层这句另有一个用例钉住）。
 *
 * 只覆盖变量层，不覆盖页眉、页脚等消费端的计算样式（那些来自 surfaces，由本机 `test:visual` 对账）。
 *
 * Step 6 有意加深了品牌色与次要文字色（D3、D6）。冻结基线是迁移前的真实记录，不改；
 * 这里把「有意的变更」显式列成 STEP6_CHANGES：种子必须等于「冻结基线 + 这三项」，
 * 一项都不能多（多改一个变量就会变红），也不能少（没改到位同样变红）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { BUILTIN_THEME_PACK_SEEDS } from "@funwind/db";
import { describe, expect, it } from "vitest";
import { renderTokenVars } from "./token-render";
import { tokensSchema } from "./token-schema";

const FIXTURES = path.resolve(import.meta.dirname, "../../../e2e-visual/fixtures");
const TOKENS_DIR = path.resolve(import.meta.dirname, "../../styles/tokens");
const REM_PX = 16;
const read = (file: string) => readFileSync(file, "utf8");

const frozen = (viewport: "desktop" | "mobile"): Record<string, string> =>
  (
    JSON.parse(read(path.join(FIXTURES, `qy2010-computed.${viewport}.json`))) as {
      variables: Record<string, string>;
    }
  ).variables;

/** 种子的浅色令牌：先过 schema，种子不合法时这里直接抛错 */
function seedLightTokens() {
  const seed = BUILTIN_THEME_PACK_SEEDS.find((candidate) => candidate.id === "qy2010");
  if (!seed) throw new Error("种子里没有 qy2010");
  const parsed = tokensSchema.parse(seed.definition.tokens);
  if (!parsed.light) throw new Error("qy2010 种子没有 tokens.light");
  return parsed.light;
}

/**
 * Step 6 的有意变更（变量 → [冻结值, 新值]）：主色与焦点环同步加深，次要文字色加深。
 * 冻结值必须仍是 fixture 里的值，防止有人把这张表当成「想改什么就改什么」的口子。
 */
const STEP6_CHANGES: Record<string, readonly [string, string]> = {
  "--primary": ["#147ba9", "#116a92"],
  "--ring": ["#147ba9", "#116a92"],
  "--muted-foreground": ["#8a8265", "#706952"],
};

/** 冻结基线套上 Step 6 的有意变更：冻结值对不上就直接报错 */
function expectedAfterStep6(frozenVars: Record<string, string>): Record<string, string> {
  const out = { ...frozenVars };
  for (const [name, [from, to]] of Object.entries(STEP6_CHANGES)) {
    if (out[name] !== from) throw new Error(`${name} 的冻结值是 ${out[name]}，不是登记的 ${from}`);
    out[name] = to;
  }
  return out;
}

const rgbText = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
};

function radiusComputed(value: string): string {
  if (value === "0px") return value;
  const ref = /^var\((--fw-radius-[a-z]+)\)$/.exec(value);
  if (!ref) throw new Error(`无法换算的圆角：${value}`);
  const declaration = new RegExp(`${ref[1]}:\\s*([0-9.]+)rem`).exec(
    read(path.join(TOKENS_DIR, "primitives.css")),
  );
  if (!declaration) throw new Error(`primitives.css 里找不到 ${ref[1]}`);
  return `${Number(declaration[1]) * REM_PX}px`;
}

function shadowComputed(value: string): string {
  const m = /^(-?\d+px) (-?\d+px) (-?\d+px) (-?\d+px) rgb\((\d+) (\d+) (\d+) \/ ([0-9.]+)\)$/.exec(
    value,
  );
  if (!m) throw new Error(`无法换算的阴影：${value}`);
  return `rgba(${m[5]}, ${m[6]}, ${m[7]}, ${m[8]}) ${m[1]} ${m[2]} ${m[3]} ${m[4]}`;
}

const gradientComputed = (value: string) => value.replace(/#[0-9a-f]{6}/g, (hex) => rgbText(hex));

const fontComputed = (value: string) =>
  value
    .split(", ")
    .map((family) => /^"([A-Za-z][A-Za-z0-9_-]*)"$/.exec(family)?.[1] ?? family)
    .join(", ");

const lengthComputed = (value: string) =>
  value.endsWith("rem") ? `${parseFloat(value) * REM_PX}px` : value;

/** 渲染器输出 → 浏览器计算值的写法；没有对应规则的变量原样放行（颜色、角度、百分比、透明度等） */
function computedOf(vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(vars)) {
    if (name === "--radius") out[name] = radiusComputed(value);
    else if (name.startsWith("--shadow-")) out[name] = shadowComputed(value);
    else if (name === "--gradient-brand") out[name] = gradientComputed(value);
    else if (name === "--fw-font-display") out[name] = fontComputed(value);
    else if (name === "--band-width") out[name] = lengthComputed(value);
    else out[name] = value;
  }
  return out;
}

/** 种子在浏览器里实际生效的变量：种子写的，加上从基础层继承来的板块卡遮罩色（= 本包的 --card） */
function effectiveVars(): Record<string, string> {
  const rendered = renderTokenVars(seedLightTokens());
  return { "--band-mask-color": rendered["--card"] ?? "", ...computedOf(rendered) };
}

describe("qy2010 种子令牌 ⇄ Step 0 冻结基线", () => {
  it.each(["desktop", "mobile"] as const)(
    "%s：34 个令牌变量的计算值 = 冻结基线 + Step 6 的三项有意变更，其余逐项相等",
    (viewport) => {
      const baseline = frozen(viewport);
      expect(Object.keys(baseline), "fixture 不能是空的或残缺的，否则对账是空转").toHaveLength(34);
      expect(effectiveVars()).toEqual(expectedAfterStep6(baseline));
    },
  );

  it.each(["desktop", "mobile"] as const)(
    "%s：fixture 里这三项仍是迁移前冻结的旧值（Step 6 不改冻结基线本身）",
    (viewport) => {
      const baseline = frozen(viewport);
      for (const [name, [from]] of Object.entries(STEP6_CHANGES)) {
        expect(baseline[name], name).toBe(from);
      }
    },
  );

  it("有意变更表只动这三项，且每一项新旧值都不同（防止登记了却没变）", () => {
    expect(Object.keys(STEP6_CHANGES).sort()).toEqual([
      "--muted-foreground",
      "--primary",
      "--ring",
    ]);
    for (const [name, [from, to]] of Object.entries(STEP6_CHANGES)) {
      expect(from, name).not.toBe(to);
    }
  });

  it("基础层仍把板块卡遮罩色定义为 var(--card)：种子不写 maskColor 才能继承到本包的卡片色", () => {
    expect(read(path.join(TOKENS_DIR, "themes/default.css"))).toMatch(
      /--band-mask-color:\s*var\(--card\);/,
    );
  });

  it("种子的颜色全部是小写十六进制：与渲染器输出和 fixture 的写法一致，没有靠大小写转换蒙混过关", () => {
    const colors = Object.values(seedLightTokens().colors ?? {});
    expect(colors).toHaveLength(22);
    for (const color of colors) expect(color).toBe(color.toLowerCase());
  });
});
