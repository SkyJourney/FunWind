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
import type { Step } from "./step-types.js";

/**
 * 迁移管线：顺序即依赖顺序。
 * 身份 → 版块 → 内容 → 积分/徽章 → 社交 → 计数重算（计数必须最后，依赖全部明细）。
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
  countersStep,
];
