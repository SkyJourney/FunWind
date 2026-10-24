/**
 * 归一化唯一键（运行时 schema 的一部分，不属于任何导入适配层）。
 * users.username_key / users.email_key 的取值规则：trim + toLowerCase，**不做 NFKC**
 * ——半角 ｻｸﾗ 不得与 サクラ 碰撞，平/片假名也必须各自独立（さくら ≠ サクラ）。
 * 注册、登录查找、导入三处必须共用同一个函数，否则同一个人会查不到自己的账号。
 */
export const normalizeKey = (s: string): string => s.trim().toLowerCase();
