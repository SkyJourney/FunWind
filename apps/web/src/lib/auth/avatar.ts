/**
 * 旧站头像路径算法（M4 前置探查实证，双样本校验）：
 *   uid 20709 → avatar/000/02/07/20709_middle.jpg
 *   uid 25940 → avatar/000/02/59/25940.jpg
 * 规律：avatar/{pad3(⌊uid/1e6⌋)}/{pad2(⌊uid/1e4⌋)}/{pad2(⌊uid/100⌋)}/{uid}[_middle|_small].jpg
 * 头像位于 attachment/ 目录之下——由 /attachment/** 路由直接服务，无需新路由。
 */

export type AvatarSize = "" | "_middle" | "_small";

const pad = (n: number, w: number) => String(n).padStart(w, "0");

export function legacyAvatarPath(uid: number, size: AvatarSize = "_middle"): string {
  const shard1 = pad(Math.floor(uid / 1_000_000) % 1000, 3);
  const shard2 = pad(Math.floor(uid / 10_000) % 100, 2);
  const shard3 = pad(Math.floor(uid / 100) % 100, 2);
  return `avatar/${shard1}/${shard2}/${shard3}/${uid}${size}.jpg`;
}

/** 完整站内 URL（走 /attachment 静态路由） */
export function legacyAvatarUrl(uid: number, size: AvatarSize = "_middle"): string {
  return `/attachment/${legacyAvatarPath(uid, size)}`;
}
