import type { KeyboardEvent } from "react";

/**
 * 文本框里按回车时，不提交它所在的表单（M11.6 Step 3c）。
 *
 * 主题编辑器是一个大表单，保存按钮是它的默认提交按钮；浏览器的隐式提交规则是
 * 「在文本框里按回车 = 点默认提交按钮」。令牌面板里有几十个颜色框和数字框，
 * 在其中任意一个按回车，都会把整个主题包提交并升版本，而作者只是想确认这一格。
 * 颜色框和数字框每次合法输入都已立即生效，回车没有额外的「确认」可做，所以直接吞掉。
 *
 * 名称、说明这类普通文本框不用它：在那里按回车保存是预期行为。
 * 按 `key` 判断，主键盘与小键盘的回车都是 "Enter"；带不带修饰键都一样处理。
 */
export function blockEnterSubmit(event: KeyboardEvent<HTMLInputElement>): void {
  if (event.key === "Enter") event.preventDefault();
}
