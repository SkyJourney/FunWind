/**
 * 编辑器草稿（M6.3 §6）：未发送的内容保存在浏览器的 localStorage 中，只是个人便利，读写都包在 try/catch 里，
 * 存储不可用（隐私模式、被禁用）时编辑器照常工作。
 *
 * 键格式：`funwind:draft:<userId>:<kind>:<id>`（kind = thread / reply / edit）。键里含用户 id，换账号不会串草稿；
 * 退出登录时由 clearDraftsForUser 清除该用户的全部草稿。
 */

const PREFIX = "funwind:draft:";

export function draftKey(
  userId: number | null,
  kind: "thread" | "reply" | "edit",
  id: number | string,
): string {
  return `${PREFIX}${userId ?? "guest"}:${kind}:${id}`;
}

export function readDraft(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeDraft(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 配额或存储被禁用：草稿丢失是可以接受的，不影响发帖
  }
}

export function removeDraft(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // 同上
  }
}

/** 提交中的草稿键（暂存）：提交即把草稿移到这里，主键随之清空，因此成功后不会留下「未发送的草稿」提示 */
export function stagedKey(key: string): string {
  return `${key}:sent`;
}

/**
 * 提交：草稿从主键移入暂存键。没有草稿时暂存键也清空，失败跳回时正文就回到服务端原文。
 * 服务端校验失败跳回时，EditorShell 从暂存键恢复正文；暂存键只会在下一次提交时被覆盖。
 */
export function stageDraft(key: string): void {
  const md = readDraft(key);
  if (md === null) removeDraft(stagedKey(key));
  else writeDraft(stagedKey(key), md);
  removeDraft(key);
}

/** 退出登录：删除该用户的全部草稿键（包括 guest 之外的所有对象） */
export function clearDraftsForUser(userId: number | null): void {
  try {
    const prefix = `${PREFIX}${userId ?? "guest"}:`;
    const doomed: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k !== null && k.startsWith(prefix)) doomed.push(k);
    }
    for (const k of doomed) window.localStorage.removeItem(k);
  } catch {
    // 同上
  }
}

/** 退出登录时使用：清除本浏览器中全部编辑器草稿（不区分用户，比逐用户清理更严格） */
export function clearAllDrafts(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k !== null && k.startsWith(PREFIX)) doomed.push(k);
    }
    for (const k of doomed) window.localStorage.removeItem(k);
  } catch {
    // 同上
  }
}
