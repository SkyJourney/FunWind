import { SURFACES, type SurfaceCapabilities } from "@/lib/theme/surface-schema";
import { BAND_FIELDS, COLOR_GROUPS, SHADOW_FIELDS, SHADOW_LABELS } from "./token-draft";

/**
 * 把服务端的校验问题翻成作者看得懂的话（M11.6 Step 3e）。
 *
 * 服务端给的是 `路径: 消息`，例如 `tokens.light.shadows.s1.blur: Too big: expected number to be <=80`。
 * 路径翻成编辑器里看到的名字；消息原样保留（颜色、透明度的消息本来就是中文，其余是 zod 的英文默认消息）。
 * 只覆盖 `pwa`、`tokens`、`surfaces` 三类；认不出的路径整条原样显示，不猜。
 * 名字取自编辑器正在用的定义；只在编辑器里写死的几处名字由测试交叉核对。
 */

const MODE_LABELS: Record<string, string> = { light: "浅色档", dark: "深色档" };

/** 区域能力的名字，与编辑器里各分区的标题一致；键类型取自 schema，加了能力忘了加名字会编译不过 */
const CAPABILITY_LABELS: Record<keyof SurfaceCapabilities, string> = {
  fill: "背景填充",
  overlay: "覆盖遮罩",
  border: "边框",
  text: "文字颜色",
  blur: "毛玻璃模糊",
  contentSlot: "内容插槽",
};

const PWA_LABELS: Record<string, string> = {
  themeColor: "浏览器主题色",
  backgroundColor: "PWA 背景色",
};

const COLOR_LABELS: Record<string, string> = Object.fromEntries(
  COLOR_GROUPS.flatMap((group) => group.items.map((item) => [item.key, item.label])),
);

const SHADOW_FIELD_LABELS: Record<string, string> = Object.fromEntries([
  ...SHADOW_FIELDS.map((spec) => [spec.key, spec.label]),
  ["color", "颜色"],
]);

const BAND_FIELD_LABELS: Record<string, string> = Object.fromEntries([
  ...BAND_FIELDS.map((spec) => [spec.key, spec.label]),
  ["mask", "显示渐隐遮罩"],
  ["maskColor", "遮罩色"],
  ["dim", "整体压暗"],
]);

const GRADIENT_FIELD_LABELS: Record<string, string> = {
  angle: "角度",
  from: "起点色",
  to: "终点色",
};

/** 在表里按键取名字；用 hasOwn，防止 `constructor` 这类键取到原型上的东西 */
function pick(table: Record<string, string>, key: string | undefined): string | undefined {
  return key !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;
}

/** `tokens.<档>.…` 的名字序列；认不出返回 null。每一类只认它自己有的层级，多出来的段交给调用方原样显示 */
function tokenLabels(rest: string[]): string[] | null {
  const root = "全站令牌";
  if (rest.length === 0) return [root];
  const mode = pick(MODE_LABELS, rest[0]);
  if (!mode) return null;
  const labels = [root, mode];
  const [, group, key, field, extra] = rest;
  switch (group) {
    case undefined:
      return labels;
    case "colors": {
      if (key === undefined) return [...labels, "颜色"];
      const color = pick(COLOR_LABELS, key);
      return color && field === undefined ? [...labels, "颜色", color] : null;
    }
    case "radius":
      return key === undefined ? [...labels, "圆角"] : null;
    case "displayFont":
      return key === undefined ? [...labels, "展示字体"] : null;
    case "shadows": {
      if (key === undefined) return [...labels, "阴影"];
      const slot = pick(SHADOW_LABELS, key);
      if (!slot || extra !== undefined) return null;
      if (field === undefined) return [...labels, slot];
      const name = pick(SHADOW_FIELD_LABELS, field);
      return name ? [...labels, slot, name] : null;
    }
    case "brandGradient": {
      if (key === undefined) return [...labels, "品牌渐变"];
      const name = pick(GRADIENT_FIELD_LABELS, key);
      return name && field === undefined ? [...labels, "品牌渐变", name] : null;
    }
    case "band": {
      if (key === undefined) return [...labels, "板块卡"];
      const name = pick(BAND_FIELD_LABELS, key);
      return name && field === undefined ? [...labels, "板块卡", name] : null;
    }
    default:
      return null;
  }
}

/** `surfaces.<区域>.<档>.<能力>.…` 的名字序列；认不出返回 null。能力之后的段原样接在括号里 */
function surfaceLabels(rest: string[]): string[] | null {
  if (rest.length === 0) return ["区域设置"];
  const surface = SURFACES.find((candidate) => candidate.id === rest[0]);
  if (!surface) return null;
  if (rest.length === 1) return [surface.label];
  const mode = pick(MODE_LABELS, rest[1]);
  if (!mode) return null;
  if (rest.length === 2) return [surface.label, mode];
  const capability = pick(CAPABILITY_LABELS, rest[2]);
  if (!capability) return null;
  const tail = rest.slice(3);
  return [surface.label, mode, tail.length > 0 ? `${capability}（${tail.join(".")}）` : capability];
}

function pathLabels(path: string): string[] | null {
  const [head, ...rest] = path.split(".");
  switch (head) {
    case "pwa": {
      if (rest.length === 0) return ["浏览器与 PWA 颜色"];
      const name = pick(PWA_LABELS, rest[0]);
      return name && rest.length === 1 ? ["浏览器与 PWA 颜色", name] : null;
    }
    case "tokens":
      return tokenLabels(rest);
    case "surfaces":
      return surfaceLabels(rest);
    default:
      return null;
  }
}

/**
 * 一条校验问题 → 展示文字。
 * `路径: 消息` 在**第一个** `: ` 处拆开（消息里可以有冒号）；路径为空只显示消息；
 * 路径认不出来，整条原样返回。
 */
export function describeIssue(issue: string): string {
  const cut = issue.indexOf(": ");
  if (cut < 0) return issue;
  const path = issue.slice(0, cut);
  const message = issue.slice(cut + 2);
  if (path === "") return message;
  const labels = pathLabels(path);
  return labels ? `${labels.join(" · ")}：${message}` : issue;
}
