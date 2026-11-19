import "@/modules";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import { getPointRewardConfig, getPunchRewardConfig } from "@/lib/points/reward-load";
import { getGateFeeRate } from "@/lib/gates/unlock";

export const dynamic = "force-dynamic";

/** GET /api/manage/points/rules：积分规则只读聚合（发帖奖励/打卡奖励/门闸费率） */
export const GET = manageEndpoint(
  async () => {
    const [threadReward, punchReward, gateFeeRate] = await Promise.all([
      getPointRewardConfig(),
      getPunchRewardConfig(),
      getGateFeeRate(),
    ]);
    return manageOk({ threadReward, punchReward, gateFeeRate });
  },
  { endpoint: "points.rules" },
);
