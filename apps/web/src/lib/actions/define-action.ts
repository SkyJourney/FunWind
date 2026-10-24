// 使用内核的 Server Action 须求值模块注册表（硬约定 9）：经 defineAction 的入口自动满足，不必逐个文件再写
import "@/modules";
import { headers } from "next/headers";
import { notFound, redirect, unstable_rethrow } from "next/navigation";
import type { ZodType } from "zod";
import { rateLimit } from "@/lib/auth/ratelimit";
import { requireAdmin, type AdminPermission } from "@/lib/authz/require-admin";
import type { AdminActor } from "@/lib/authz/admin";
import { getCurrentSubject } from "@/lib/authz/subject";
import type { Subject } from "@/lib/authz/types";
import { clientIpFrom } from "@/lib/net/client-ip";
import { formDataToObject } from "./form-data";

/**
 * Server Action 的统一骨架（M6.1，设计见 docs/milestones/M6.1-write-path.md §8）。
 *
 * 为什么要有它：M6 一次加入发帖 / 回帖 / 编辑 / 上传 / 审核等十几个 Action，各写一套「求值模块、取主体、
 * 登录要求、频控、手工 Number(formData.get())、错误转跳转」，漏一环就是一个洞（M5.6 之前真发生过：后台 Action 缺鉴权、
 * 入口漏写模块注册表）。这里把这几件事收口：
 *   1. 求值模块注册表（本文件顶部的 import "@/modules"）；
 *   2. 鉴权：`guest`（谁都可以）/ `user`（未登录跳登录页）/ `{ admin: 权限点 }`（**先于任何取数**调用 requireAdmin）；
 *   3. 取主体与可信 IP；
 *   4. 声明式频控（每条必须写明超限时怎么办，不允许"默认放行"）；
 *   5. zod 结构校验——失败一律 404（与篡改请求的既有行为一致，不泄露校验细节）。业务文案（"用户名需 2–20 位"）仍在 run 里判断；
 *   6. 正确重新抛出 Next 的控制流异常（redirect() / notFound() 是靠抛异常实现的，被 catch 吞掉会让跳转失效）。
 * 返回值恒为 `(formData: FormData) => Promise<void>`，可直接用作 `<form action={…}>`。
 */

export type ActionAuth = "guest" | "user" | { admin: AdminPermission };

export interface ActionContext {
  /** 评估主体（游客也有：userId 为 null） */
  subject: Subject;
  /** 当前用户 id；`auth: "guest"` 时可能为 null，`user` / `admin` 时一定非 null */
  userId: number | null;
  /** 可信客户端 IP；取不到（直连部署）为 null，此时 IP 级限额应跳过 */
  ip: string | null;
  /** `auth: { admin }` 时的操作者（供写审计） */
  admin?: AdminActor;
}

export interface RateLimitPolicy<I> {
  /** 限额键；返回 null 表示本次不适用（如取不到可信 IP 的 IP 级限额） */
  key: (ctx: ActionContext, input: I) => string | null;
  max: number;
  windowMs: number;
  /** 超限时做什么（必须是跳转 / 404，即抛出 Next 控制流异常）。刻意设为必填：不允许"忘了处理" */
  onLimit: (ctx: ActionContext, input: I) => Promise<never> | never;
}

export interface ActionDef<I> {
  /** 动作名（命名空间风格，如 gate.unlock）：用于日志与测试 */
  name: string;
  auth: ActionAuth;
  /** 缺省表示不需要输入（如登出） */
  input?: ZodType<I>;
  rateLimit?: RateLimitPolicy<I>[];
  /** 业务体：用 redirect() / notFound() 收尾（抛出），或正常返回（页面不跳转） */
  run: (ctx: ActionContext, input: I, formData: FormData) => Promise<void>;
}

/** 可注入的依赖：单测替换；真实导出的 defineAction 用下面的 realDeps */
export interface ActionDeps {
  getSubject: () => Promise<Subject>;
  getIp: () => Promise<string | null>;
  requireAdmin: (perm: AdminPermission) => Promise<AdminActor>;
  rateLimit: (key: string, max: number, windowMs: number) => { allowed: boolean };
  /** 未登录时的去向 */
  loginPath: string;
}

const realDeps: ActionDeps = {
  getSubject: getCurrentSubject,
  getIp: async () => clientIpFrom(await headers()),
  requireAdmin: (perm) => requireAdmin(perm),
  rateLimit,
  loginPath: "/login",
};

export function createDefineAction(deps: ActionDeps) {
  return function defineAction<I = undefined>(
    def: ActionDef<I>,
  ): (formData: FormData) => Promise<void> {
    return async function action(formData: FormData): Promise<void> {
      // 1. 鉴权 —— admin 先于一切（含读取表单、取主体）：入口的第一个 await 就是它
      let admin: AdminActor | undefined;
      if (typeof def.auth === "object") admin = await deps.requireAdmin(def.auth.admin);

      const subject = await deps.getSubject();
      if (def.auth === "user" && subject.userId === null) redirect(deps.loginPath);
      const ctx: ActionContext = {
        subject,
        userId: admin ? admin.userId : subject.userId,
        ip: admin ? admin.ip : await deps.getIp(),
        admin,
      };

      try {
        // 2. 结构校验：失败 → 404
        let input = undefined as I;
        if (def.input) {
          const parsed = def.input.safeParse(formDataToObject(formData));
          if (!parsed.success) notFound();
          input = parsed.data;
        }

        // 3. 频控：按声明顺序检查，任一超限就交给该条的 onLimit（它必须抛出控制流异常）
        for (const policy of def.rateLimit ?? []) {
          const key = policy.key(ctx, input);
          if (key === null) continue;
          if (!deps.rateLimit(key, policy.max, policy.windowMs).allowed) {
            await policy.onLimit(ctx, input);
            // onLimit 没有抛出 = 写法有误；宁可拒绝也不放行
            notFound();
          }
        }

        await def.run(ctx, input, formData);
      } catch (e) {
        // redirect() / notFound() 靠抛异常实现：必须原样重新抛出，吞掉会让跳转失效
        unstable_rethrow(e);
        console.error(`[action] ${def.name} 失败:`, e);
        throw e;
      }
    };
  };
}

export const defineAction = createDefineAction(realDeps);
