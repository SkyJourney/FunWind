/** 站点地址（邮件链接等）；由根 .env APP_URL 注入（next.config env 通道，非密钥） */
export const APP_URL = (process.env.APP_URL ?? "http://127.0.0.1:3100").replace(/\/$/, "");

export const SITE_NAME = "青翼字幕组";
