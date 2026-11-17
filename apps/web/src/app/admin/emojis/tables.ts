/**
 * 表情管理页回执/错误文案表（M19 从 page.tsx 迁出以控行数；码来自 lib/emoji/admin.ts 与 actions）。
 */

/** 上传失败码 → 可读文案（码来自 lib/emoji/admin.ts 的拒绝分支） */
export const UPLOAD_ERRORS: Record<string, string> = {
  empty: "文件内容为空",
  type: "格式不支持：表情只接受 PNG / GIF / WebP",
  undecodable: "无法解码图片（文件损坏或伪装）",
  size: "尺寸超限：上限 200×200 像素",
  bytes: "文件超限：上限 200KB",
};

export const SAVED: Record<string, string> = {
  "group-created": "分组已创建。",
  "group-renamed": "分组已改名。",
  "group-toggled": "分组状态已更新。",
  "group-deleted": "分组已删除。",
  "group-moved": "分组顺序已更新。",
  "group-icon": "分组标题图已更新（面板分组标题旁即时生效）。",
  upload: "表情已上传（见成功计数；失败明细见下方提示）。",
  "emoji-renamed": "表情已更新。",
  "emoji-moved": "表情顺序已更新。",
  "emoji-toggled": "表情状态已更新。",
};
