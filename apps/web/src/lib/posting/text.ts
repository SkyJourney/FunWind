/**
 * 发帖文本的规范化与长度校验（M6.1，纯函数）。
 *
 * 标题：一行文字，要抗"看起来一样、实际不同"的伎俩——零宽字符、RTL 覆盖符、连续空白都会让两个标题肉眼相同而内容不同，
 * 也会让版面错乱（RTL 覆盖符能把后面的文字倒过来显示）。所以标题统一去掉这些字符并折叠空白。
 * 已知取舍：零宽连接符 U+200D 也被去掉，由它连成的 emoji 组合（如家庭 emoji）会拆成单个 emoji，标题里可以接受。
 * 正文是 Markdown，空白与换行有意义，只去掉会破坏存储 / 显示的控制字符并统一换行。
 * 长度按"字符"（码点）计，而不是 UTF-16 单元，否则一个生僻汉字或 emoji 会被算成两个。
 */

/** 控制字符（C0、DEL、C1）、零宽与格式字符、双向控制符。标题里一律剔除 */
const TITLE_STRIP = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩؜﻿]/g;
/** 全部空白（含 NBSP、全角空格、换行制表）→ 折叠成一个普通空格 */
const WHITESPACE_RUN = /[\s 　]+/g;
/** 正文里不允许的控制字符：除换行和制表外的 C0、DEL（NUL 会截断某些存储与日志） */
const BODY_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** 按码点计长 */
export const charLength = (s: string): number => [...s].length;

export function normalizeTitle(raw: string): string {
  // 先把空白折叠（把换行、制表变成空格），再剔除不可见字符，最后再折叠一次：剔除可能让两侧的空格相邻
  return raw
    .replace(WHITESPACE_RUN, " ")
    .replace(TITLE_STRIP, "")
    .replace(WHITESPACE_RUN, " ")
    .trim();
}

export type TextCheck<T extends string> =
  { ok: true; value: string } | { ok: false; code: T; message: string };

export function checkTitle(raw: string, max: number): TextCheck<"title_empty" | "title_too_long"> {
  const title = normalizeTitle(raw);
  if (title === "") return { ok: false, code: "title_empty", message: "标题不能为空" };
  if (charLength(title) > max) {
    return { ok: false, code: "title_too_long", message: `标题不能超过 ${max} 个字符` };
  }
  return { ok: true, value: title };
}

export function normalizeBody(raw: string): string {
  return raw.replace(/\r\n?/g, "\n").replace(BODY_CONTROL, "").trim();
}

/**
 * 校验正文。传入的是**完整源码**（含 `:::gate` 围栏里的隐藏正文），所以上限天然是「公开部分 + 全部隐藏正文」合计，
 * 作者没法把长文塞进门控来绕过上限。围栏标记本身只多出几十个字符，按保守方向算，不单独扣除。
 */
export function checkBody(raw: string, max: number): TextCheck<"body_empty" | "body_too_long"> {
  const body = normalizeBody(raw);
  if (body === "") return { ok: false, code: "body_empty", message: "正文不能为空" };
  if (charLength(body) > max) {
    return { ok: false, code: "body_too_long", message: `正文不能超过 ${max} 个字符` };
  }
  return { ok: true, value: body };
}

/** 版主操作的理由：trim 后 1–200 个字符，去控制字符（审计表 note 是 varchar(255)） */
export const REASON_MAX = 200;
export function checkReason(raw: string): TextCheck<"reason_required" | "reason_too_long"> {
  const reason = normalizeTitle(raw);
  if (reason === "") return { ok: false, code: "reason_required", message: "请填写理由" };
  if (charLength(reason) > REASON_MAX) {
    return { ok: false, code: "reason_too_long", message: `理由不能超过 ${REASON_MAX} 个字符` };
  }
  return { ok: true, value: reason };
}
