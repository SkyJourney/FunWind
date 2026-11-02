/**
 * 邮件域公共类型（邮件专项）。
 *
 * 邮件分五类，类别决定页脚措辞与视觉重音，也写入发送记录供后台筛选：
 *  · verify   验证令牌类：验证邮箱 / 重置密码 / 认领 / 注销确认——有链接、有有效期、仅一次
 *  · security 安全强制类：改密 / 换绑 / 限制 / 申诉结果——不受用户偏好控制
 *  · notice   场景通知类：私信 / 售出 / 审核结果——用户在「设置 → 通知」开启邮件渠道才发
 *  · digest   每日汇总
 *  · system   系统 / 后台触发（测试邮件）
 */
export type MailKind = "verify" | "security" | "notice" | "digest" | "system";

/** 渲染邮件所需的站点品牌信息；由 getMailBrand() 解析，纯函数模板只消费不读库 */
export interface MailBrand {
  siteName: string;
  /** 对外访问地址（无尾斜杠），用于按钮链接与页脚 */
  siteUrl: string;
  tagline: string;
  /** 主题色（#RRGGBB），取全站默认主题包的 PWA themeColor */
  accent: string;
}

/** 一封可发送的邮件：HTML 与纯文本双版本；kind/scene 随信进入发送记录 */
export interface MailMessage {
  kind: MailKind;
  /** 场景标识 = 模板 id，如 verify-email、pm-received */
  scene: string;
  subject: string;
  html: string;
  text: string;
}
