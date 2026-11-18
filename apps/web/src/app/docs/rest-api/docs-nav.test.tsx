import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "@/lib/markdown";
import { DOCS_SECTIONS } from "@/lib/manage/api-docs-md";
import { MANAGE_ERROR_CODES } from "@/lib/manage/errors";
import { MANAGE_ENDPOINTS, MANAGE_PERMISSION_DOMAINS } from "@/lib/manage/permissions";
import { DocsMobileNav, DocsNav } from "./docs-nav";

/** 用站内渲染管线检查实际可见的元信息，而非只检查中间数据。 */
function renderDocs() {
  const root = document.createElement("div");
  for (const { slug, md } of DOCS_SECTIONS) {
    const section = document.createElement("section");
    section.id = slug;
    section.innerHTML = renderMarkdown(md);
    root.append(section);
  }
  return root;
}

function endpointMetadata(section: Element) {
  return Object.fromEntries(
    Array.from(section.querySelectorAll("table:first-of-type tbody tr"), (row) => {
      const [name, value] = row.querySelectorAll("td");
      return [name?.textContent, value?.textContent];
    }),
  );
}

describe("管理 REST 静态文档", () => {
  it("每个目录条目恰有一节正文和一个分域锚点，渲染的方法与权限均与目录一致", () => {
    render(<DocsNav />);
    const root = renderDocs();
    const targets = [...root.querySelectorAll("section")];
    expect(new Set(targets.map(({ id }) => id)).size).toBe(targets.length);
    const links = screen.getAllByRole("link");
    for (const link of links) {
      const href = link.getAttribute("href");
      expect(href).toMatch(/^#/);
      expect(targets.filter(({ id }) => `#${id}` === href)).toHaveLength(1);
    }

    const documentedIds: string[] = [];
    for (const section of targets) {
      const meta = endpointMetadata(section);
      if (!("请求" in meta)) continue;
      const id = meta.令牌权限?.match(/端点 ID：(\S+)$/)?.[1];
      const match = Object.entries(MANAGE_ENDPOINTS).find(([endpointId]) => endpointId === id);
      expect(match, section.id).toBeDefined();
      if (!match) continue;
      const [endpointId, { method, path, domain, access }] = match;
      const domainTitle = MANAGE_PERMISSION_DOMAINS[domain];
      const permission = "permission" in match[1] ? ` + ${match[1].permission}` : "";
      expect(meta.请求).toBe(`${method} ${path}`);
      expect(meta.数据域).toBe(domainTitle);
      expect(meta.令牌权限).toBe(
        `${domain}:${access}（${access === "read" ? "读" : "写"}）；端点 ID：${endpointId}`,
      );
      expect(meta.持有人全局权限).toBe(`site.admin + admin.roles${permission}`);

      const matchingLinks = links.filter((link) => link.getAttribute("href") === `#${section.id}`);
      expect(matchingLinks).toHaveLength(1);
      const [link] = matchingLinks;
      expect(link?.firstElementChild?.textContent).toBe(method);
      expect(link?.closest("ul")?.previousElementSibling?.textContent).toBe(domainTitle);
      documentedIds.push(endpointId);
    }
    expect(documentedIds.sort()).toEqual(Object.keys(MANAGE_ENDPOINTS).sort());
  });

  it("渲染所有错误码、状态和对应响应文案", () => {
    const envelope = renderDocs().querySelector("#docs-envelope");
    const rows = Array.from(envelope?.querySelectorAll("tbody tr") ?? [], (row) =>
      Array.from(row.querySelectorAll("td"), (cell) => cell.textContent),
    );
    expect(rows).toEqual(
      Object.entries(MANAGE_ERROR_CODES).map(([code, { status, message }]) => [
        code,
        String(status),
        message,
      ]),
    );
  });

  it("移动抽屉保持原生跳锚并在点击后关闭", async () => {
    render(<DocsMobileNav />);
    fireEvent.click(screen.getByRole("button", { name: "文档导航" }));
    const drawer = await screen.findByRole("dialog", { name: "文档导航" });
    const nav = within(drawer).getByRole("navigation", { name: "文档导航" });
    const link = within(nav).getByRole("link", { name: /POST.*审核单条帖子/ });
    expect(link.getAttribute("href")).toBe("#ep-post-review");
    expect(fireEvent.click(link)).toBe(true);
    expect(screen.queryByRole("dialog", { name: "文档导航" })).toBeNull();
  });
});
