/**
 * 保存被拒时，把服务端的校验问题带回编辑页（M11.6 Step 3e）。
 *
 * 问题列表走查询参数（重复的 `issue=`），与运营排期页带回错误和草稿是同一做法，不用 cookie。
 * 查询参数是不可信输入：编码时限条数、限长度；解析时同样限，别人拼一个超长的链接过来也撑不出大页面。
 * 编码比展示多留一条，用来判断「还有更多问题」。
 */

/** 带进跳转地址的最大条数（比页面展示的多 1 条，用来判断有没有被省略的） */
export const MAX_ISSUES_CARRIED = 6;
/** 页面最多展示几条 */
export const MAX_ISSUES_SHOWN = 5;
/** 每条最长字符数（含省略号）。按码点截断，不会把一个汉字或 emoji 劈成两半 */
export const MAX_ISSUE_LENGTH = 120;

/** 去空白、丢掉空串与非字符串，超长的截断并加省略号，最多留 MAX_ISSUES_CARRIED 条 */
function clean(items: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") continue;
    const text = item.trim();
    if (!text) continue;
    const chars = [...text];
    out.push(
      chars.length > MAX_ISSUE_LENGTH ? `${chars.slice(0, MAX_ISSUE_LENGTH - 1).join("")}…` : text,
    );
    if (out.length === MAX_ISSUES_CARRIED) break;
  }
  return out;
}

/** 校验问题 → 拼在跳转地址后面的 `&issue=…` 片段；没有问题返回空串 */
export function encodeIssues(errors: readonly string[] | undefined): string {
  return clean(errors ?? [])
    .map((issue) => `&issue=${encodeURIComponent(issue)}`)
    .join("");
}

/** Next 给的 `issue` 查询参数（缺省 / 单个字符串 / 字符串数组）→ 清理后的问题列表 */
export function parseIssues(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return [];
  return clean(Array.isArray(raw) ? raw : [raw]);
}
