import { listAnnouncements } from "/Volumes/Projects/FunWind/apps/web/src/lib/announcements/queries.ts";
const guest = await listAnnouncements(false);
console.log("游客可见:", guest.map((a) => `${a.id}:${a.title}`).join(" | "));
const member = await listAnnouncements(true);
console.log("会员可见:", member.map((a) => `${a.id}:${a.title}`).join(" | "));
