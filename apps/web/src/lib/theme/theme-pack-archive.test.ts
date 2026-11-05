import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { FULL_TOKENS } from "@/test/theme-token-fixture";
import {
  MAX_THEME_PACK_ARCHIVE_BYTES,
  MAX_THEME_PACK_ASSETS,
  MAX_THEME_PACK_ASSET_BYTES,
  MAX_THEME_PACK_LOGO_BYTES,
  buildThemePackArchive,
  parseThemePackArchive,
} from "./theme-pack-archive";

const DECOR_FILE = `decor-${"a".repeat(32)}.png`;
const PNG_BYTES = Buffer.from("decor-resource-bytes");
const DEFINITION = {
  surfaces: {
    "forum-band": {
      light: {
        fill: {
          type: "image" as const,
          asset: DECOR_FILE,
          position: "top left",
          size: "cover",
          repeat: "no-repeat" as const,
          blend: "soft-light" as const,
          opacity: 0.7,
        },
      },
    },
  },
};

/** 带完整语义令牌的定义（M11.6 Step 3g）：不引用任何素材，单独检验 tokens 与 pwa 的往返 */
const TOKEN_DEFINITION = {
  pwa: { themeColor: "#147ba9", backgroundColor: "#f6f3e7" },
  surfaces: { header: { light: { fill: { type: "solid" as const, color: "#112233" } } } },
  tokens: FULL_TOKENS,
};
const tokenArchive = () =>
  buildThemePackArchive({
    id: "token-theme",
    name: "令牌包",
    description: "",
    schemaVersion: 1,
    definition: TOKEN_DEFINITION,
    assets: [],
  });

/**
 * 把 manifest 里的一段文本改成等长的另一段，并重算 CRC32（本地头与中央目录各一处），
 * 让篡改后的归档仍能通过 ZIP 层校验：这样被拒绝的原因只可能是定义本身的校验，而不是校验和对不上。
 * 构建器把 theme.json 作为第一个条目、以存储方式（未压缩）写入。
 */
function tamperManifest(archive: Uint8Array, from: string, to: string): Buffer {
  const bytes = Buffer.from(archive);
  const needle = Buffer.from(from);
  const at = bytes.indexOf(needle);
  expect(at, "要替换的文本必须出现在归档里").toBeGreaterThan(0);
  expect(bytes.indexOf(needle, at + 1), "要替换的文本必须在归档里唯一").toBe(-1);
  expect(to.length, "替换前后必须等长，ZIP 里记录的长度才不用改").toBe(from.length);
  Buffer.from(to).copy(bytes, at);
  const nameLength = bytes.readUInt16LE(26);
  const size = bytes.readUInt32LE(22);
  const checksum = crc32(bytes.subarray(30 + nameLength, 30 + nameLength + size));
  bytes.writeUInt32LE(checksum, 14);
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  expect(central, "找得到中央目录").toBeGreaterThan(0);
  bytes.writeUInt32LE(checksum, central + 16);
  return bytes;
}

describe("主题包 ZIP 导入导出格式", () => {
  it("带完整 tokens（浅深两档、阴影、品牌渐变、板块卡参数）的包往返后逐项相同", () => {
    const unpacked = parseThemePackArchive(tokenArchive());
    expect(unpacked.definition).toEqual(TOKEN_DEFINITION);
    // 色值只校验格式、不规范化：刻意混用大小写，往返后必须逐字相同
    expect(unpacked.definition.tokens?.light?.colors?.primary).toBe("#147BA9");
    expect(unpacked.definition.tokens?.dark?.colors?.primary).toBe("#4FB0DB");
  });

  it("没有 tokens 的包（旧归档的形状）往返后仍没有 tokens，也不会凭空多出空对象", () => {
    const archive = buildThemePackArchive({
      id: "old-theme",
      name: "旧包",
      description: "",
      schemaVersion: 1,
      definition: { pwa: TOKEN_DEFINITION.pwa, surfaces: TOKEN_DEFINITION.surfaces },
      assets: [],
    });
    // manifest 以存储方式写入，文本直接出现在归档字节里
    expect(Buffer.from(archive).includes("tokens")).toBe(false);
    const unpacked = parseThemePackArchive(archive);
    expect("tokens" in unpacked.definition).toBe(false);
    expect(unpacked.definition.pwa).toEqual(TOKEN_DEFINITION.pwa);
  });

  it("导入时令牌同样要过校验：改成非法色值（校验和已重算）被拒绝，改成另一个合法色值则通过", () => {
    const archive = tokenArchive();
    const accepted = parseThemePackArchive(tamperManifest(archive, "#4FB0DB", "#4FB0DC"));
    expect(accepted.definition.tokens?.dark?.colors?.primary).toBe("#4FB0DC");
    expect(() => parseThemePackArchive(tamperManifest(archive, "#4FB0DB", "#4FB0DZ"))).toThrow(
      "definition 未通过安全校验",
    );
  });

  it("manifest 与 PNG 素材可以完整往返，保留 SHA-256 与 definition 引用", () => {
    const archive = buildThemePackArchive({
      id: "paper-theme",
      name: "暖纸",
      description: "完整资源包",
      schemaVersion: 1,
      definition: DEFINITION,
      assets: [{ kind: "decor", poolFile: DECOR_FILE, bytes: PNG_BYTES }],
    });
    const unpacked = parseThemePackArchive(archive);
    expect(unpacked).toMatchObject({
      id: "paper-theme",
      name: "暖纸",
      description: "完整资源包",
      definition: DEFINITION,
      assets: [{ kind: "decor", poolFile: DECOR_FILE, bytes: PNG_BYTES }],
    });
    expect(unpacked.assets[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("拒绝损坏 ZIP、文件路径注入、素材引用缺失与字节篡改", () => {
    expect(() => parseThemePackArchive(Buffer.from("not a zip"))).toThrow("大小不合法");
    expect(() => parseThemePackArchive(Buffer.alloc(32))).toThrow("ZIP 目录缺失");
    expect(() =>
      buildThemePackArchive({
        id: "bad/pack",
        name: "坏包",
        description: "",
        schemaVersion: 1,
        definition: { surfaces: {} },
        assets: [],
      }),
    ).toThrow("id 不合法");
    expect(() =>
      buildThemePackArchive({
        id: "safe-pack",
        name: "坏素材",
        description: "",
        schemaVersion: 1,
        definition: DEFINITION,
        assets: [],
      }),
    ).toThrow("未打包的素材");

    const unsafePathArchive = Buffer.from(
      buildThemePackArchive({
        id: "safe-pack",
        name: "安全包",
        description: "",
        schemaVersion: 1,
        definition: { surfaces: {} },
        assets: [],
      }),
    );
    const originalName = Buffer.from("theme.json");
    const unsafeName = Buffer.from("../evil.js");
    let pathOffset = 0;
    while ((pathOffset = unsafePathArchive.indexOf(originalName, pathOffset)) >= 0) {
      unsafeName.copy(unsafePathArchive, pathOffset);
      pathOffset += unsafeName.length;
    }
    expect(() => parseThemePackArchive(unsafePathArchive)).toThrow("非法或重复路径");

    const archive = Buffer.from(
      buildThemePackArchive({
        id: "paper-theme",
        name: "暖纸",
        description: "",
        schemaVersion: 1,
        definition: DEFINITION,
        assets: [{ kind: "decor", poolFile: DECOR_FILE, bytes: PNG_BYTES }],
      }),
    );
    const payloadOffset = archive.indexOf(PNG_BYTES);
    expect(payloadOffset).toBeGreaterThan(0);
    archive[payloadOffset] ^= 0xff;
    expect(() => parseThemePackArchive(archive)).toThrow("校验和不匹配");
  });

  it("构建器限制版本、素材类型/大小、重复资源数量与定义结构", () => {
    const base = {
      id: "safe-pack",
      name: "安全包",
      description: "",
      schemaVersion: 1,
      definition: { surfaces: {} },
      assets: [],
    };
    expect(() => buildThemePackArchive({ ...base, schemaVersion: 2 })).toThrow("schema 版本");
    expect(() =>
      buildThemePackArchive({
        ...base,
        assets: [{ kind: "bad", poolFile: "logo-bad.png", bytes: PNG_BYTES } as never],
      }),
    ).toThrow("未知素材类型");
    expect(() =>
      buildThemePackArchive({
        ...base,
        assets: [{ kind: "decor", poolFile: "../escape.png", bytes: PNG_BYTES }],
      }),
    ).toThrow("素材文件名不合法");
    expect(() =>
      buildThemePackArchive({
        ...base,
        assets: [
          { kind: "decor", poolFile: DECOR_FILE, bytes: PNG_BYTES },
          { kind: "decor", poolFile: DECOR_FILE, bytes: PNG_BYTES },
        ],
      }),
    ).toThrow("重复素材");
    expect(() =>
      buildThemePackArchive({
        ...base,
        assets: Array.from({ length: MAX_THEME_PACK_ASSETS + 1 }, () => ({
          kind: "decor" as const,
          poolFile: DECOR_FILE,
          bytes: PNG_BYTES,
        })),
      }),
    ).toThrow("数量超过上限");
    expect(() =>
      buildThemePackArchive({
        ...base,
        assets: [
          {
            kind: "logo",
            poolFile: `logo-${"b".repeat(32)}.png`,
            bytes: Buffer.alloc(MAX_THEME_PACK_LOGO_BYTES + 1),
          },
        ],
      }),
    ).toThrow("素材大小超出主题包限制");
    expect(() =>
      buildThemePackArchive({
        ...base,
        definition: { surfaces: { unknown: { light: {} } } },
      }),
    ).toThrow("definition 校验失败");
    const largeBytes = Buffer.alloc(MAX_THEME_PACK_ASSET_BYTES);
    const largeAssets = Array.from({ length: 6 }, (_, index) => ({
      kind: "decor" as const,
      poolFile: `decor-${index.toString(16).padStart(32, "0")}.png`,
      bytes: largeBytes,
    }));
    expect(largeAssets.length * largeBytes.length).toBeGreaterThan(MAX_THEME_PACK_ARCHIVE_BYTES);
    expect(() => buildThemePackArchive({ ...base, assets: largeAssets })).toThrow("超过 20MB");
  });
});
