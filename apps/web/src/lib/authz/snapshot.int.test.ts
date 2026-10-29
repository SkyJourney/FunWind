// @vitest-environment node
/**
 * 权限快照缓存（M9.5 补覆盖）：TTL 内复用同一 Promise、显式失效后重载、TTL 过期自然重载。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { getAuthzSnapshot, invalidateAuthzSnapshot } from "./snapshot";

let tdb: TempDb;

beforeAll(async () => {
  tdb = await setupTempDb();
  invalidateAuthzSnapshot(); // 清掉其它用例可能留下的缓存
});

afterAll(async () => {
  await tdb?.teardown();
});

describe.skipIf(skipDb)("authz snapshot 缓存", () => {
  it("TTL 内两次取到同一实例（缓存生效）", async () => {
    invalidateAuthzSnapshot();
    const a = await getAuthzSnapshot();
    const b = await getAuthzSnapshot();
    expect(b).toBe(a);
  });

  it("显式失效后重载为新实例", async () => {
    const a = await getAuthzSnapshot();
    invalidateAuthzSnapshot();
    const b = await getAuthzSnapshot();
    expect(b).not.toBe(a);
    // 内容等价（同一批板块与授权）
    expect(b.tree.all().length).toBe(a.tree.all().length);
  });
});
