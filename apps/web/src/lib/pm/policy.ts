import { eq } from "drizzle-orm";
import { getWebDb, userProfiles } from "@funwind/db";

/** 本人私信接收策略；取值由 API / Server Action 的输入 schema 校验。 */
export type PmPolicy = "all" | "following" | "off";

/** 只更新既有 profile 的私信策略；缺失时保持原有无操作语义，不补建或重读资料。 */
export async function setUserPmPolicy(userId: number, policy: PmPolicy): Promise<void> {
  await getWebDb()
    .update(userProfiles)
    .set({ pmPolicy: policy })
    .where(eq(userProfiles.userId, userId));
}
