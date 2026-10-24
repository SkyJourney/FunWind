import { readFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
const m = JSON.parse(readFileSync("dist/.vite/manifest.json", "utf8"));
const main = Object.values(m).find((e) => e.isEntry);
const reach = (key, seen = new Set()) => {
  if (seen.has(key)) return seen;
  seen.add(key);
  for (const k of m[key].imports ?? []) reach(k, seen);
  return seen;
};
const mainSet = reach(Object.keys(m).find((k) => m[k] === main));
const fmt = (n) => (n / 1024).toFixed(0) + " kB";
const sz = (file) => {
  const b = readFileSync("dist/" + file);
  return [b.length, gzipSync(b).length];
};
for (const [id, match] of [
  ["CodeMirror 6", "cm.ts"],
  ["Milkdown Crepe", "milkdown.ts"],
  ["Tiptap v3", "tiptap.ts"],
]) {
  const key = Object.keys(m).find((k) => k.endsWith(match));
  if (!key) {
    console.log(id, "未找到");
    continue;
  }
  let raw = 0,
    gz = 0,
    css = 0,
    cssGz = 0;
  const own = [...reach(key)].filter((k) => !mainSet.has(k));
  for (const k of own) {
    const [r, g] = sz(m[k].file);
    raw += r;
    gz += g;
    for (const c of m[k].css ?? []) {
      const [cr, cg] = sz(c);
      css += cr;
      cssGz += cg;
    }
  }
  console.log(
    `${id.padEnd(16)} JS ${fmt(raw)} (gzip ${fmt(gz)}) · CSS ${fmt(css)} (gzip ${fmt(cssGz)}) · ${own.length} 个 chunk`,
  );
}
const mk = Object.keys(m).find((k) => m[k].isEntry);
const [r, g] = sz(m[mk].file);
console.log(`共享主包（React + 渲染器 unified + 裁剪库等） JS ${fmt(r)} (gzip ${fmt(g)})`);
