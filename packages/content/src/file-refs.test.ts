import { describe, expect, it } from "vitest";
import { extractFileRefs, extractKeys } from "./file-refs.js";

const A = "ab/cd/" + "abcd".repeat(16) + ".png"; // 哈希前缀 abcd，目录 ab/cd 一致
const B = "12/34/" + "1234".repeat(16) + ".webp";
const gate = (key: string, body: string) =>
  `:::gate{key="${key}" unlock="points" price="10"}\n${body}\n:::`;

describe("extractKeys", () => {
  it("抽取 Markdown 图片与裸链接中的 key，保序去重", () => {
    const text = `![a](/files/${A}) 文字 /files/${B} 再来 ![a2](/files/${A})`;
    expect(extractKeys(text)).toEqual([A, B]);
  });

  it("目录与哈希前缀不一致的 key 忽略", () => {
    const bad = "ff/ff/" + "abcd".repeat(16) + ".png";
    expect(extractKeys(`![x](/files/${bad})`)).toEqual([]);
  });

  it("扩展名按路由同款规则贪婪匹配（pngxyz 仍是合法形态）；不存在的 key 由保存时的存在性校验拒绝", () => {
    expect(extractKeys(`/files/${A}xyz`)).toEqual([A + "xyz"]);
  });

  it("不是 /files 路径的内容忽略", () => {
    expect(extractKeys(`https://example.com/${A}`)).toEqual([]);
  });
});

describe("extractFileRefs", () => {
  it("公开部分的引用进 publicRefs，门控隐藏正文的引用进对应门控", () => {
    const source = `公开 ![p](/files/${A})\n\n${gate("g1", `隐藏 ![h](/files/${B})`)}`;
    const r = extractFileRefs(source);
    expect(r.publicRefs).toEqual([A]);
    expect(r.gateRefs).toEqual([{ key: "g1", refs: [B] }]);
  });

  it("没有门控引用的门控不出现在 gateRefs", () => {
    const source = `${gate("g1", "只有文字")}\n\n![p](/files/${A})`;
    const r = extractFileRefs(source);
    expect(r.publicRefs).toEqual([A]);
    expect(r.gateRefs).toEqual([]);
  });

  it("多个门控各自归属，同一文件在不同门控中重复时各自登记", () => {
    const source = [gate("g1", `![x](/files/${A})`), gate("g2", `![y](/files/${A})`)].join("\n\n");
    const r = extractFileRefs(source);
    expect(r.publicRefs).toEqual([]);
    expect(r.gateRefs).toEqual([
      { key: "g1", refs: [A] },
      { key: "g2", refs: [A] },
    ]);
  });

  it("外层用 :::: 包裹（门控正文含 ::: 行）时仍能抽取", () => {
    const source = `::::gate{key="g1" unlock="points" price="10"}\n![x](/files/${B})\n:::\n::::`;
    const r = extractFileRefs(source);
    expect(r.gateRefs).toEqual([{ key: "g1", refs: [B] }]);
  });

  it("语法错误时仍尽力返回（保存时由调用方以 errors 拒绝）", () => {
    const source = `![p](/files/${A})\n\n:::gate{key="g1" unlock="points" price="10"}\n未闭合`;
    expect(() => extractFileRefs(source)).not.toThrow();
    expect(extractFileRefs(source).publicRefs).toEqual([A]);
  });

  it("性质：随机把引用散落在公开与各门控中，抽取结果与放入的集合一致", () => {
    // 固定种子的线性同余生成器，保证可复现
    let seed = 20261025;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const pool = [A, B, "aa/aa/" + "aaaa".repeat(16) + ".gif"];
    for (let round = 0; round < 50; round++) {
      const publicSet = new Set<string>();
      const gateSets = new Map<string, Set<string>>();
      const parts: string[] = [];
      const gateCount = Math.floor(rnd() * 3);
      for (let i = 0; i < 4; i++) {
        const key = pool[Math.floor(rnd() * pool.length)]!;
        if (rnd() < 0.5) {
          publicSet.add(key);
          parts.push(`![p${i}](/files/${key})`);
        } else {
          parts.push(`文字 ${i}`);
        }
      }
      for (let g = 0; g < gateCount; g++) {
        const k = `g${g + 1}`;
        const set = new Set<string>();
        const key = pool[Math.floor(rnd() * pool.length)]!;
        set.add(key);
        gateSets.set(k, set);
        parts.push(gate(k, `![h](/files/${key})`));
      }
      const r = extractFileRefs(parts.join("\n\n"));
      expect(new Set(r.publicRefs)).toEqual(publicSet);
      expect(r.gateRefs.map((x) => [x.key, new Set(x.refs)])).toEqual(
        [...gateSets.entries()].map(([k, s]) => [k, s]),
      );
    }
  });
});
