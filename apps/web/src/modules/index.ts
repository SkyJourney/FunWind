import { registerModule, sealRegistry } from "./kernel/registry";
import { demoCheckin } from "./demo-checkin/index";
import { pointsModule } from "./points/index";
import { checkinModule } from "./checkin/index";
import { badgesModule } from "./badges/index";

/**
 * 模块清单（唯一入口）：
 *  - 启用/停用一个模块 = 增删此数组一行 + `pnpm modules:toggle <id> off`（module_state 状态残留无害）
 *  - 扩展事件/槽位清单 = 改 kernel/types.ts + docs/MODULES.md 说明
 */
const MODULES = [demoCheckin, pointsModule, checkinModule, badgesModule];

for (const m of MODULES) {
  registerModule(m);
}
sealRegistry();
