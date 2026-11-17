/**
 * 后台管理操作的业务错误：消息可直接展示给管理员（页面回执 err=文案）。
 * 独立成文件（M20）：lib/manage/tokens.ts 也抛它——若留在 admin.ts 会与
 * 「admin.ts 嵌入联动吊销 → import tokens → tokens import AdminError」形成循环依赖。
 */
export class AdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminError";
  }
}
