import {
  authzStep,
  forumPrefixesStep,
  forumsStep,
  legacyPasswordStep,
  restrictionsStep,
  settingsStep,
  usersStep,
} from "./steps.js";
import {
  badgesStep,
  contentStep,
  countersStep,
  emojiStep,
  followsStep,
  pollsStep,
  pointsStep,
  reactionsStep,
} from "./steps-content.js";
import { filesStep } from "./steps-files.js";
import type { Step } from "./step-types.js";

/**
 * 迁移管线：顺序即依赖顺序。
 * 身份 → 版块 → 内容 → 积分/徽章 → 社交 → 文件登记 → 计数重算（计数必须最后，依赖全部明细）。
 * files 依赖 users / content / badges 在转换阶段登记的文件引用，四者成组运行（见 GROUPS）。
 */
export const STEPS: Step[] = [
  forumsStep,
  forumPrefixesStep,
  usersStep,
  legacyPasswordStep,
  restrictionsStep,
  authzStep,
  settingsStep,
  emojiStep,
  contentStep,
  pointsStep,
  badgesStep,
  followsStep,
  reactionsStep,
  pollsStep,
  filesStep,
  countersStep,
];

/**
 * 必须成组运行的步骤：files 依赖这三个步骤登记的引用，单独重跑任何一个都会让 files / attachments 与之脱节。
 * run.ts 选中其中任意一个时，会把整组一并运行。
 */
export const FILE_GROUP: readonly string[] = ["users", "content", "badges", "files"];
/** content 重跑会整表替换 threads（缓存计数列被重置），counters 必须跟随重算（M9.5 教训） */
export const COUNTER_FOLLOW: readonly string[] = ["content", "counters"];

/**
 * 展开用户指定的部分迁移步骤及联动：文件依赖组、计数重算、users → legacy-password。
 * 独立导出供单测锁定顺序，避免只跑 users 时漏掉凭据回填。
 */
export function selectMigrationSteps(only: readonly string[]): Step[] {
  const selected = new Set(only);
  if (FILE_GROUP.some((name) => selected.has(name)))
    FILE_GROUP.forEach((name) => selected.add(name));
  if (selected.has("users")) selected.add("legacy-password");
  if (COUNTER_FOLLOW.slice(0, -1).some((name) => selected.has(name))) selected.add("counters");
  return only.length > 0 ? STEPS.filter((step) => selected.has(step.name)) : STEPS;
}
