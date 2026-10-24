/**
 * E2E 夹具常量：与 packages/db/src/e2e-fixtures.ts 的 E2E_FIX 一一对应。
 * Playwright 以 CJS 加载用例，无法 import 纯 ESM 的 @funwind/db，所以这里镜像一份——改夹具时两处同步。
 * 夹具由 `pnpm db:e2e-fixtures` 写入（根 test:e2e 与 CI 都会先跑），用例不再依赖任何真实迁移数据。
 */
export const FIX = {
  anime: { id: 951, name: "『E2E 动画』", prefixId: 9501, prefixName: "连载中" },
  water: { id: 952, name: "『E2E 水区』", total: 60, perPage: 25, globalPins: 3 },
  staff: { id: 953, name: "『E2E 站务组』" },
  /** 演示种子里的受限版块（演示团队有授权） */
  teamForum: { id: 904, name: "『字幕组内部区』" },
  thread: {
    emoji: 950001,
    image: 950002,
    deletedAuthor: 950003,
    poll: 950004,
    attach: 950005,
    deletedState: 950006,
    staffSecret: 950007,
    gateAttach: 950008,
    gfm: 950009,
    waterPin: 950021,
  },
  /** 门控附件帖（付费 10 / 回复可见两个门控）里的附件名与门控图；demo_member(90005) 已购买付费门控 */
  gateAttach: {
    publicName: "公开附件.txt",
    paidName: "付费附件.txt",
    paidImageName: "门控图.png",
    replyName: "回复可见附件.txt",
    paidText: "E2E 付费可见正文。",
    replyText: "E2E 回复可见正文。",
  },
  /** 水区第一个普通主题的标题（用来断言“置顶帖不会重复进入普通列表”） */
  placeholderUserId: 95001,
  staffSecretTitle: "[内部] E2E 站务议程",
  teamSecretTitle: "[内部] 本季度字幕分工表",
} as const;
