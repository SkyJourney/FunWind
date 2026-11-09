import { sql } from "drizzle-orm";
import { getWebDb, QY2010_PACK, QY2010_PACK_DEFINITION, themePackages } from "@funwind/db";

/**
 * qy2010 夹具行（站长 2026-11-08 拍板：qy2010 移出内置种子，作为站点自定义主题存在）。
 * 需要 qy2010 的集成测试用它插入「数据库启用的包」——主题目录校验（isKnownPackId）、
 * theme.pack 排期 effect、用户偏好等链路都要求 DB 中存在启用包。definition 取自 db 包的
 * 定稿（QY2010_PACK_DEFINITION，与 E2E 夹具同一来源），令牌对比度等断言用它。
 * opts.isBuiltin 默认 false（生产语义）；apply-pack-logo 的 bundled 联动分支用例传 true 覆盖代码路径。
 */
export async function insertQy2010Fixture(opts: { isBuiltin?: boolean } = {}): Promise<void> {
  await getWebDb()
    .insert(themePackages)
    .values({
      id: QY2010_PACK.id,
      name: QY2010_PACK.name,
      description: "",
      schemaVersion: 1,
      definition: QY2010_PACK_DEFINITION as unknown as Record<string, unknown>,
      assets: [],
      enabled: true,
      isBuiltin: opts.isBuiltin ?? false,
      revision: 1,
      createdAt: sql`NOW()`,
      updatedAt: sql`NOW()`,
    });
}
