/**
 * D5 一次性清洗（dev/已迁移库）：forums.description 存量裸 HTML → 纯文本。
 * 清洗规则与 migration/src/lib/legacy-html.ts 同源（此处内联副本，规则变更须两处同步）。
 * 用法：pnpm exec tsx scripts/clean-forum-descriptions.mts [--apply]
 *   默认 dry-run 只打印将要变更的行；--apply 才写库。
 */
import { config } from "dotenv";
config({ path: "../../.env", override: false });

import { eq } from "drizzle-orm";
import { getWebDb, forums } from "@funwind/db";

function sanitizeLegacyHtml(input: string | null): string | null {
  if (input === null) return null;
  if (input === "") return null;
  const cleaned = input
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned === "" ? null : cleaned;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const db = getWebDb();
  const rows = await db
    .select({ id: forums.id, name: forums.name, description: forums.description })
    .from(forums);
  let changed = 0;
  for (const r of rows) {
    const cleaned = sanitizeLegacyHtml(r.description);
    if (cleaned === r.description) continue;
    changed++;
    console.log(`#${r.id} ${r.name}`);
    console.log(`  旧: ${JSON.stringify(r.description)}`);
    console.log(`  新: ${JSON.stringify(cleaned)}`);
    if (apply) {
      await db.update(forums).set({ description: cleaned }).where(eq(forums.id, r.id));
    }
  }
  console.log(
    `\n共 ${rows.length} 个版块，需清洗 ${changed} 个${apply ? "（已写入）" : "（dry-run，未写入；加 --apply 执行）"}`,
  );
  process.exit(0);
}

main();
