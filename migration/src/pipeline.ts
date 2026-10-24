import {
  authzStep,
  forumPrefixesStep,
  forumsStep,
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
  messagesStep,
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
  messagesStep,
  filesStep,
  countersStep,
];

/**
 * 必须成组运行的步骤：files 依赖这三个步骤登记的引用，单独重跑任何一个都会让 files / attachments 与之脱节。
 * run.ts 选中其中任意一个时，会把整组一并运行。
 */
export const FILE_GROUP: readonly string[] = ["users", "content", "badges", "files"];
