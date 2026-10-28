import { describe, expect, it } from "vitest";
import { extractInlineImages, removeImageFromMarkdown } from "./inline-images";

const H = "a".repeat(64);
const url = `/files/aa/aa/${H}.png`;

describe("extractInlineImages", () => {
  it("只认站内文件图片：保序、去重", () => {
    const h2 = "b".repeat(64);
    const md = `文 ![](${url}) 又 ![图](${url}) ![x](/files/bb/bb/${h2}.jpg) ![表情](/emoji/134.gif) ![外](https://a.cn/x.png)`;
    expect(extractInlineImages(md).map((i) => i.url)).toEqual([url, `/files/bb/bb/${h2}.jpg`]);
  });
  it("普通链接、目录与哈希前缀不一致的不算", () => {
    expect(extractInlineImages(`[下载](${url}) ![](/files/zz/zz/${H}.png)`)).toEqual([]);
  });
  it("门控隐藏正文里的图片同样会被列出（作者视角的完整源码）", () => {
    const md = `:::gate{key="g1" unlock="reply"}\n![](${url})\n:::`;
    expect(extractInlineImages(md)).toHaveLength(1);
  });
});

describe("removeImageFromMarkdown", () => {
  it("删掉全部指向该地址的图片语法，其它内容原样保留", () => {
    const other = `/files/bb/bb/${"b".repeat(64)}.png`;
    const md = `前 ![](${url}) 中 ![x](${url}) 后 ![](${other})`;
    expect(removeImageFromMarkdown(md, url)).toBe(`前  中  后 ![](${other})`);
  });
});
