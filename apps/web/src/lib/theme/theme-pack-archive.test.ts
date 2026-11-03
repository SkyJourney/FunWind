import { describe, expect, it } from "vitest";
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

describe("主题包 ZIP 导入导出格式", () => {
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
