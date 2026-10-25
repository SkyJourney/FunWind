/**
 * 「内容更新于」标记（M6.5）：隐藏正文在读者看到之后被作者改过，读者应当知道内容变了。
 * 纯函数，只产生一行时间文案，不含任何隐藏内容。
 *
 * 规则：
 *  · 从未更新（contentUpdatedAt 为 NULL）→ 不显示；
 *  · 作者 / 版主 → 不显示（他们自己改的，或随时能看到最新版本）；
 *  · 已解锁且解锁时间不早于最近一次更新 → 不显示（读者看到的已是最新版本）；
 *  · 其它情况（未解锁，或解锁早于更新，或以回复等条件开放、没有解锁时间）→ 显示。
 *    回复类条件没有解锁时间，无法判断读者是否看到了最新版本，保守地显示。
 * 时间字符串统一为库内的 `YYYY-MM-DD HH:MM:SS`（北京墙面时间），字典序即时间序。
 */
export function contentUpdateNote(input: {
  contentUpdatedAt: string | null;
  unlockedAt?: string | null;
  /** 作者或版主视角 */
  seeLatest: boolean;
}): string | null {
  const { contentUpdatedAt, unlockedAt, seeLatest } = input;
  if (contentUpdatedAt === null || seeLatest) return null;
  if (unlockedAt && unlockedAt >= contentUpdatedAt) return null;
  return `内容更新于 ${contentUpdatedAt.slice(0, 16)}`;
}
