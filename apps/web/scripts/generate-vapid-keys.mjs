// 生成 Web Push VAPID 密钥对（M18）：输出三行 env，填入 .env / 服务器 .env。
// 用法：pnpm --filter @funwind/web exec node scripts/generate-vapid-keys.mjs
// 公钥可下发客户端；私钥只在 env、不入库，泄漏须重新生成并让旧订阅失效。
import webpush from "web-push";

const keys = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log("VAPID_SUBJECT=mailto:admin@qingyisub.top");
