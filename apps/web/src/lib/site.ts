/** 站点地址（邮件链接等）；由根 .env APP_URL 注入（next.config env 通道，非密钥） */
export const APP_URL = (process.env.APP_URL ?? "http://127.0.0.1:3100").replace(/\/$/, "");

/** 站点名/副标题回退默认值（site_settings("site.identity") 未配置时使用；M10.6b 起后台可改） */
export const SITE_NAME = "青翼字幕组";
export const SITE_TAGLINE = "日语·ACG 情怀社区";
