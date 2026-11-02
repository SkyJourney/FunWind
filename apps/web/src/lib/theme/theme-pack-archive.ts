import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { z } from "zod";
import { parseThemePackDefinition, type ThemePackDefinition } from "./surface-schema";
import { getThemePackDecorRefs } from "./packs";

/** 主题包 ZIP 边界：ZIP 总量 20MB、单资源 4MB、资源数 32；不支持 ZIP64 或加密条目。 */
export const MAX_THEME_PACK_ARCHIVE_BYTES = 20 * 1024 * 1024;
export const MAX_THEME_PACK_ASSET_BYTES = 4 * 1024 * 1024;
export const MAX_THEME_PACK_LOGO_BYTES = 512 * 1024;
export const MAX_THEME_PACK_ASSETS = 32;
const MAX_MANIFEST_BYTES = 256 * 1024;
const THEME_PACK_ID_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const THEME_ASSET_RE = /^(logo|decor)-[a-f0-9]{32}\.png$/;

const manifestAssetSchema = z
  .object({
    kind: z.enum(["logo", "decor"]),
    poolFile: z.string().regex(THEME_ASSET_RE),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().positive().max(MAX_THEME_PACK_ASSET_BYTES),
  })
  .strict()
  .refine(
    (asset) =>
      asset.poolFile.startsWith(`${asset.kind}-`) &&
      asset.bytes <=
        (asset.kind === "logo" ? MAX_THEME_PACK_LOGO_BYTES : MAX_THEME_PACK_ASSET_BYTES),
    "素材类型、文件名或大小不合法",
  );

const manifestSchema = z
  .object({
    format: z.literal("funwind-theme-pack"),
    formatVersion: z.literal(1),
    package: z
      .object({
        id: z.string().regex(THEME_PACK_ID_RE),
        name: z.string().trim().min(1).max(60),
        description: z.string().max(200),
        schemaVersion: z.literal(1),
        definition: z.unknown(),
        assets: z.array(manifestAssetSchema).max(MAX_THEME_PACK_ASSETS),
      })
      .strict(),
  })
  .strict();

export interface ThemePackArchiveAssetInput {
  kind: "logo" | "decor";
  poolFile: string;
  bytes: Uint8Array;
}

export interface ThemePackArchiveInput {
  id: string;
  name: string;
  description: string;
  schemaVersion: number;
  definition: ThemePackDefinition;
  assets: readonly ThemePackArchiveAssetInput[];
}

export interface ImportedThemePackArchive {
  id: string;
  name: string;
  description: string;
  schemaVersion: 1;
  definition: ThemePackDefinition;
  assets: Array<ThemePackArchiveAssetInput & { sha256: string }>;
}

interface ZipEntry {
  name: string;
  bytes: Buffer;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertAsset(kind: string, poolFile: string, bytes: Uint8Array): void {
  if (kind !== "logo" && kind !== "decor") throw new Error("未知素材类型");
  if (!THEME_ASSET_RE.test(poolFile) || !poolFile.startsWith(`${kind}-`)) {
    throw new Error("素材文件名不合法");
  }
  const maxBytes = kind === "logo" ? MAX_THEME_PACK_LOGO_BYTES : MAX_THEME_PACK_ASSET_BYTES;
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    throw new Error("素材大小超出主题包限制");
  }
}

function makeZip(entries: readonly ZipEntry[]): Buffer {
  const localRecords: Buffer[] = [];
  const centralRecords: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const bytes = entry.bytes;
    const checksum = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localRecords.push(local, name, bytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(bytes.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralRecords.push(central, name);
    localOffset += local.length + name.length + bytes.length;
  }

  const centralDirectory = Buffer.concat(centralRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  const archive = Buffer.concat([...localRecords, centralDirectory, end]);
  if (archive.length > MAX_THEME_PACK_ARCHIVE_BYTES) throw new Error("主题包压缩文件超过 20MB");
  return archive;
}

/** 构建不带执行代码的 ZIP：manifest JSON + PNG 资源，PNG 本身保持原样存储。 */
export function buildThemePackArchive(input: ThemePackArchiveInput): Uint8Array {
  if (!THEME_PACK_ID_RE.test(input.id)) throw new Error("主题包 id 不合法");
  if (input.schemaVersion !== 1) throw new Error("不支持的主题包 schema 版本");
  if (input.assets.length > MAX_THEME_PACK_ASSETS) throw new Error("主题包素材数量超过上限");
  const seen = new Set<string>();
  const assets = input.assets.map((asset) => {
    assertAsset(asset.kind, asset.poolFile, asset.bytes);
    if (seen.has(asset.poolFile)) throw new Error("主题包含有重复素材");
    seen.add(asset.poolFile);
    return {
      kind: asset.kind,
      poolFile: asset.poolFile,
      sha256: sha256(asset.bytes),
      bytes: asset.bytes.byteLength,
    };
  });
  const parsedDefinition = parseThemePackDefinition(input.definition);
  if (!parsedDefinition.ok) throw new Error("主题包 definition 校验失败");
  const declaredDecor = new Set(
    assets.filter((asset) => asset.kind === "decor").map((asset) => asset.poolFile),
  );
  for (const file of getThemePackDecorRefs(parsedDefinition.value)) {
    if (!declaredDecor.has(file)) throw new Error(`主题定义引用了未打包的素材：${file}`);
  }
  const manifest = {
    format: "funwind-theme-pack",
    formatVersion: 1,
    package: {
      id: input.id,
      name: input.name,
      description: input.description,
      schemaVersion: 1,
      definition: parsedDefinition.value,
      assets,
    },
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  if (manifestBytes.length > MAX_MANIFEST_BYTES) throw new Error("主题包 JSON 超过 256KB");
  const entries: ZipEntry[] = [{ name: "theme.json", bytes: manifestBytes }];
  for (const asset of input.assets) {
    entries.push({
      name: `assets/${asset.kind}/${asset.poolFile}`,
      bytes: Buffer.from(asset.bytes),
    });
  }
  return makeZip(entries);
}

function findEndRecord(bytes: Buffer): number {
  const lowerBound = Math.max(0, bytes.length - 22 - 0xffff);
  for (let offset = bytes.length - 22; offset >= lowerBound; offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function safeEntryName(name: string): boolean {
  if (name === "theme.json") return true;
  return (
    /^assets\/(decor|logo)\/(decor|logo)-[a-f0-9]{32}\.png$/.test(name) &&
    name
      .split("/")
      .at(-1)
      ?.startsWith(`${name.split("/")[1]}-`) === true
  );
}

/** 解析并校验 ZIP 目录、压缩边界、CRC32、manifest、资源摘要和路径。 */
export function parseThemePackArchive(input: Uint8Array): ImportedThemePackArchive {
  if (input.byteLength < 22 || input.byteLength > MAX_THEME_PACK_ARCHIVE_BYTES) {
    throw new Error("主题包文件大小不合法");
  }
  const bytes = Buffer.from(input);
  const endOffset = findEndRecord(bytes);
  if (endOffset < 0) throw new Error("ZIP 目录缺失");
  const disk = bytes.readUInt16LE(endOffset + 4);
  const centralDisk = bytes.readUInt16LE(endOffset + 6);
  const diskEntries = bytes.readUInt16LE(endOffset + 8);
  const entryCount = bytes.readUInt16LE(endOffset + 10);
  const centralSize = bytes.readUInt32LE(endOffset + 12);
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  const commentLength = bytes.readUInt16LE(endOffset + 20);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== entryCount ||
    entryCount < 1 ||
    entryCount > MAX_THEME_PACK_ASSETS + 1 ||
    endOffset + 22 + commentLength !== bytes.length ||
    centralOffset + centralSize !== endOffset
  ) {
    throw new Error("ZIP 目录结构不受支持");
  }

  const entries = new Map<string, Buffer>();
  let cursor = centralOffset;
  let totalBytes = 0;
  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > endOffset || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error("ZIP 中央目录损坏");
    }
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const checksum = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const entryCommentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const recordEnd = cursor + 46 + nameLength + extraLength + entryCommentLength;
    if (recordEnd > endOffset || nameLength === 0 || nameLength > 256) {
      throw new Error("ZIP 条目长度不合法");
    }
    if ((flags & 0x41) !== 0 || (flags & 0x08) !== 0 || (method !== 0 && method !== 8)) {
      throw new Error("ZIP 加密、数据描述符或压缩方式不受支持");
    }
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    let name: string;
    try {
      name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
    } catch {
      throw new Error("ZIP 文件名不是合法 UTF-8");
    }
    if (!safeEntryName(name) || entries.has(name)) throw new Error("ZIP 含有非法或重复路径");
    const isManifest = name === "theme.json";
    if (
      uncompressedSize > (isManifest ? MAX_MANIFEST_BYTES : MAX_THEME_PACK_ASSET_BYTES) ||
      compressedSize > MAX_THEME_PACK_ASSET_BYTES ||
      totalBytes + uncompressedSize > MAX_THEME_PACK_ARCHIVE_BYTES
    ) {
      throw new Error("ZIP 展开后超过大小限制");
    }

    if (localOffset + 30 > centralOffset || bytes.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error("ZIP 本地条目损坏");
    }
    const localFlags = bytes.readUInt16LE(localOffset + 6);
    const localMethod = bytes.readUInt16LE(localOffset + 8);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const localNameStart = localOffset + 30;
    const localNameEnd = localNameStart + localNameLength;
    const dataStart = localNameEnd + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (
      localFlags !== flags ||
      localMethod !== method ||
      localNameEnd > centralOffset ||
      dataEnd > centralOffset ||
      !bytes.subarray(localNameStart, localNameEnd).equals(nameBytes)
    ) {
      throw new Error("ZIP 本地与中央目录不一致");
    }
    const compressed = bytes.subarray(dataStart, dataEnd);
    let content: Buffer;
    try {
      content =
        method === 0
          ? Buffer.from(compressed)
          : inflateRawSync(compressed, { maxOutputLength: Math.max(1, uncompressedSize) });
    } catch {
      throw new Error("ZIP 条目解压失败");
    }
    if (content.length !== uncompressedSize || crc32(content) !== checksum) {
      throw new Error("ZIP 条目校验和不匹配");
    }
    entries.set(name, content);
    totalBytes += content.length;
    cursor = recordEnd;
  }
  if (cursor !== endOffset) throw new Error("ZIP 中央目录有多余数据");

  const manifestBytes = entries.get("theme.json");
  if (!manifestBytes) throw new Error("主题包缺少 theme.json");
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  } catch {
    throw new Error("主题包 JSON 无法解析");
  }
  const parsedManifest = manifestSchema.safeParse(rawManifest);
  if (!parsedManifest.success) throw new Error("主题包 JSON 格式不符合版本 1 schema");
  const definition = parseThemePackDefinition(parsedManifest.data.package.definition);
  if (!definition.ok) throw new Error("主题包 definition 未通过安全校验");

  const assetEntries = parsedManifest.data.package.assets;
  if (entries.size !== assetEntries.length + 1) throw new Error("ZIP 内存在未声明的文件");
  const assets = assetEntries.map((asset) => {
    const path = `assets/${asset.kind}/${asset.poolFile}`;
    const content = entries.get(path);
    if (!content) throw new Error(`主题包缺少素材：${asset.poolFile}`);
    if (content.length !== asset.bytes || sha256(content) !== asset.sha256) {
      throw new Error(`主题素材校验失败：${asset.poolFile}`);
    }
    return { ...asset, bytes: content };
  });
  const decorFiles = new Set(
    assets.filter((asset) => asset.kind === "decor").map((asset) => asset.poolFile),
  );
  for (const file of getThemePackDecorRefs(definition.value)) {
    if (!decorFiles.has(file)) throw new Error(`主题定义引用了未打包的素材：${file}`);
  }

  return {
    id: parsedManifest.data.package.id,
    name: parsedManifest.data.package.name,
    description: parsedManifest.data.package.description,
    schemaVersion: 1,
    definition: definition.value,
    assets,
  };
}
