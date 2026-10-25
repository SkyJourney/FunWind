/**
 * 上传的类型与限制（M6.4a，docs/milestones/M6.4-uploads.md §3、§7）。
 * 纯数据，无 I/O：被嗅探、校验、处理与路由共用，避免各处各写一份常量。
 */

/** 上传用途：决定大小上限、允许的类型与鉴权方式 */
export type UploadPurpose = "inline" | "attachment" | "avatar";

/** 嗅探得到的真实类型（魔数），存储扩展名与 MIME 一律取它，绝不取用户提供的扩展名 */
export type SniffedType =
  "jpeg" | "png" | "gif" | "webp" | "bmp" | "txt" | "zip" | "rar" | "7z" | "torrent";

/** 图片类型（可内联展示、可缩放、可裁剪；GIF 不重编码、不裁剪） */
export const IMAGE_TYPES: ReadonlySet<SniffedType> = new Set(["jpeg", "png", "gif", "webp", "bmp"]);

/** 存储用扩展名（写入 files.storage_key 的后缀） */
export const STORED_EXT: Record<SniffedType, string> = {
  jpeg: "jpg",
  png: "png",
  gif: "gif",
  webp: "webp",
  bmp: "bmp",
  txt: "txt",
  zip: "zip",
  rar: "rar",
  "7z": "7z",
  torrent: "torrent",
};

/** 写入 files.mime 的 MIME（/files 路由只信它，不按扩展名推断） */
export const MIME_OF: Record<SniffedType, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  txt: "text/plain",
  zip: "application/zip",
  rar: "application/vnd.rar",
  "7z": "application/x-7z-compressed",
  torrent: "application/x-bittorrent",
};

/**
 * 用户文件名允许的扩展名（小写）→ 对应的嗅探类型。
 * 旧站 7 种（gif png zip rar jpg txt torrent）∪ 新增 jpeg webp bmp 7z；不含 svg / html / js 等可脚本化类型。
 */
export const EXTENSION_TYPES: Readonly<Record<string, SniffedType>> = {
  jpg: "jpeg",
  jpeg: "jpeg",
  png: "png",
  gif: "gif",
  webp: "webp",
  bmp: "bmp",
  txt: "txt",
  zip: "zip",
  rar: "rar",
  "7z": "7z",
  torrent: "torrent",
};

/** 各用途允许的类型：inline / avatar 只接受图片；attachment 接受全部允许类型 */
export const PURPOSE_TYPES: Readonly<Record<UploadPurpose, ReadonlySet<SniffedType>>> = {
  inline: IMAGE_TYPES,
  avatar: IMAGE_TYPES,
  attachment: new Set<SniffedType>(Object.values(EXTENSION_TYPES)),
};

/** 字节上限（按用途，原始上传字节，不含 multipart 开销） */
export const MAX_BYTES: Readonly<Record<UploadPurpose, number>> = {
  inline: 10 * 1024 * 1024,
  attachment: 50 * 1024 * 1024,
  avatar: 5 * 1024 * 1024,
};

/** multipart 表单的额外开销余量（字段名、边界、forumId 等） */
export const FORM_OVERHEAD_BYTES = 64 * 1024;

/** 解码前的像素上限（防解压炸弹；sharp 的 limitInputPixels） */
export const MAX_PIXELS = 40_000_000;

/** 裁剪的最小边长（像素） */
export const MIN_CROP = 32;

/** 头像输出边长（旧站 120，此处 2 倍以适配高分屏） */
export const AVATAR_SIZE = 240;

/** 缩略图的白名单宽度；其它值一律忽略并返回原图 */
export const THUMB_WIDTHS = [320, 800, 1600] as const;

/** 单帖附件（download 行）数量上限 */
export const MAX_ATTACHMENTS_PER_POST = 20;

/** 单帖内联图片引用数量上限（正文 + 所有门控） */
export const MAX_INLINE_REFS_PER_POST = 100;
