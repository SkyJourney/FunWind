/**
 * 版块树（纯逻辑，无 IO）：邻接表 + 物化路径的内存视图。
 * 应用启动时由加载器从 forums 表构造，权限评估、目录渲染、查询过滤都靠它取祖先链与有效策略，零 SQL。
 * 设计见 docs/AUTHZ.md §8.2–8.3。
 */

export type ReadPolicy = "inherit" | "public" | "members" | "restricted";
export type WritePolicy = "inherit" | "members" | "restricted";
export type ReviewPolicy = "inherit" | "none" | "threads" | "all";

/** 版块节点：forums 表中树形结构与策略相关的列（计数等缓存列由展示层另取） */
export interface ForumNode {
  id: number;
  parentId: number;
  /** 物化路径，含自身，如 /98/130/129/53/ */
  path: string;
  depth: number;
  kind: "section" | "forum";
  name: string;
  description: string | null;
  /** 板块图内容寻址 key（M9.5 schema v2.4）；null = 无图 */
  iconKey: string | null;
  sortOrder: number;
  readPolicy: ReadPolicy;
  writePolicy: WritePolicy;
  reviewPolicy: ReviewPolicy;
  isListed: boolean;
  isArchived: boolean;
}

/** 三类策略沿树解析后的有效值 */
export interface EffectivePolicies {
  read: Exclude<ReadPolicy, "inherit">;
  write: Exclude<WritePolicy, "inherit">;
  review: Exclude<ReviewPolicy, "inherit">;
}

/** 有效策略及其来源：holderId 是声明该策略的最近祖先（含自身）；全链 inherit 时为 null（取默认值） */
export interface Resolved<T> {
  value: T;
  holderId: number | null;
}

/** 全链 inherit 时的默认策略：读公开、写需登录会员、发帖不需审核 */
export const DEFAULT_POLICIES: EffectivePolicies = {
  read: "public",
  write: "members",
  review: "none",
};

const bySort = (a: ForumNode, b: ForumNode): number => a.sortOrder - b.sortOrder || a.id - b.id;

export class ForumTree {
  private readonly nodes = new Map<number, ForumNode>();
  private readonly childrenOf = new Map<number, ForumNode[]>();
  private readonly chains = new Map<number, number[]>();

  constructor(rows: readonly ForumNode[]) {
    for (const r of rows) this.nodes.set(r.id, r);
    for (const r of [...rows].sort(bySort)) {
      // parentId 指向不存在的节点（数据损坏）时按根处理，避免子树凭空消失
      const key = this.nodes.has(r.parentId) ? r.parentId : 0;
      const list = this.childrenOf.get(key) ?? [];
      list.push(r);
      this.childrenOf.set(key, list);
    }
  }

  get size(): number {
    return this.nodes.size;
  }

  has(id: number): boolean {
    return this.nodes.has(id);
  }

  get(id: number): ForumNode | undefined {
    return this.nodes.get(id);
  }

  /** 全部节点（按根序、再深度优先排序），目录渲染用 */
  all(): ForumNode[] {
    const out: ForumNode[] = [];
    const walk = (n: ForumNode) => {
      out.push(n);
      for (const c of this.children(n.id)) walk(c);
    };
    for (const r of this.roots()) walk(r);
    return out;
  }

  roots(): ForumNode[] {
    return this.childrenOf.get(0) ?? [];
  }

  children(id: number): ForumNode[] {
    return this.childrenOf.get(id) ?? [];
  }

  /**
   * 作用域链：自身 → 父 → … → 根。节点不存在返回空数组。
   * 按 parentId 逐级上溯（带环保护），与物化路径冗余校验由 db:verify / 迁移对账负责。
   */
  chain(id: number): number[] {
    const hit = this.chains.get(id);
    if (hit) return hit;
    const out: number[] = [];
    const seen = new Set<number>();
    let cur = this.nodes.get(id);
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      out.push(cur.id);
      cur = this.nodes.get(cur.parentId);
    }
    this.chains.set(id, out);
    return out;
  }

  /** 自身及全部后代的 id（物化路径前缀匹配，不依赖递归） */
  subtree(id: number): number[] {
    const root = this.nodes.get(id);
    if (!root) return [];
    const out: number[] = [];
    for (const n of this.nodes.values()) {
      if (n.id === id || n.path.startsWith(root.path)) out.push(n.id);
    }
    return out.sort((a, b) => a - b);
  }

  /** 沿祖先链取最近一个非 inherit 的策略；全链 inherit 返回默认值（holderId=null） */
  readPolicy(id: number): Resolved<EffectivePolicies["read"]> {
    return this.resolve(id, "readPolicy", DEFAULT_POLICIES.read);
  }

  writePolicy(id: number): Resolved<EffectivePolicies["write"]> {
    return this.resolve(id, "writePolicy", DEFAULT_POLICIES.write);
  }

  reviewPolicy(id: number): Resolved<EffectivePolicies["review"]> {
    return this.resolve(id, "reviewPolicy", DEFAULT_POLICIES.review);
  }

  private resolve<K extends "readPolicy" | "writePolicy" | "reviewPolicy">(
    id: number,
    field: K,
    fallback: Exclude<ForumNode[K], "inherit">,
  ): Resolved<Exclude<ForumNode[K], "inherit">> {
    for (const cid of this.chain(id)) {
      const v = this.nodes.get(cid)![field];
      if (v !== "inherit") return { value: v as Exclude<ForumNode[K], "inherit">, holderId: cid };
    }
    return { value: fallback, holderId: null };
  }
}
