// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { getModules } from "@/modules/kernel/registry";
import { GUEST_SUBJECT, type Subject } from "@/lib/authz/types";
import {
  createDefineAction,
  defineAction as realDefineAction,
  type ActionDeps,
} from "./define-action";

/**
 * defineAction 的行为测试（依赖全部注入，不碰数据库与 cookie）。
 * redirect() / notFound() 是靠抛出带 digest 的异常实现的，这里用 outcome() 把三种结局归一：
 * 跳转 / 404 / 正常返回 / 其他异常。
 */

const MEMBER: Subject = { ...GUEST_SUBJECT, userId: 7, roles: [{ key: "member", scopeId: 0 }] };

async function outcome(p: Promise<unknown>) {
  try {
    await p;
    return { kind: "returned" as const };
  } catch (e) {
    const digest = (e as { digest?: string }).digest ?? "";
    if (digest.startsWith("NEXT_REDIRECT;")) {
      return { kind: "redirect" as const, to: digest.split(";")[2]! };
    }
    if (digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;404")) return { kind: "notFound" as const };
    return { kind: "threw" as const, error: e as Error };
  }
}

function setup(over: Partial<ActionDeps> = {}) {
  const calls: string[] = [];
  const deps: ActionDeps = {
    getSubject: async () => {
      calls.push("getSubject");
      return MEMBER;
    },
    getIp: async () => {
      calls.push("getIp");
      return "203.0.113.9";
    },
    requireAdmin: async () => {
      calls.push("requireAdmin");
      return { userId: 99, ip: "198.51.100.1" };
    },
    rateLimit: () => ({ allowed: true }),
    loginPath: "/login",
    ...over,
  };
  return { deps, calls, define: createDefineAction(deps) };
}
const form = (o: Record<string, string> = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.append(k, v);
  return f;
};

describe("鉴权", () => {
  it("guest：游客也能执行，userId 为 null，run 拿到主体与 IP", async () => {
    const { deps, define } = setup({ getSubject: async () => GUEST_SUBJECT });
    const run = vi.fn(async () => undefined);
    await define({ name: "t", auth: "guest", run })(form());
    expect(run).toHaveBeenCalledOnce();
    const ctx = (run.mock.calls[0] as unknown[])[0] as { userId: number | null; ip: string | null };
    expect(ctx.userId).toBeNull();
    expect(ctx.ip).toBe("203.0.113.9");
    expect(deps).toBeTruthy();
  });

  it("user：未登录跳登录页且 run 不执行；对照：已登录正常执行并带上 userId", async () => {
    const guest = setup({ getSubject: async () => GUEST_SUBJECT });
    const runA = vi.fn(async () => undefined);
    expect(await outcome(guest.define({ name: "t", auth: "user", run: runA })(form()))).toEqual({
      kind: "redirect",
      to: "/login",
    });
    expect(runA).not.toHaveBeenCalled();

    const member = setup();
    const runB = vi.fn(async () => undefined);
    await member.define({ name: "t", auth: "user", run: runB })(form());
    expect(((runB.mock.calls[0] as unknown[])[0] as { userId: number }).userId).toBe(7);
  });

  it("admin：requireAdmin 是第一个异步依赖，先于取主体、取 IP 与读取表单（先鉴权，后取数）", async () => {
    const { calls, define } = setup();
    const parse = vi.fn((v: unknown) => v);
    const schema = z.any().transform(parse);
    await define({ name: "t", auth: { admin: "admin.roles" }, input: schema, run: async () => {} })(
      form({ a: "1" }),
    );
    expect(calls[0]).toBe("requireAdmin");
    expect(calls.indexOf("requireAdmin")).toBeLessThan(calls.indexOf("getSubject"));
  });

  it("admin：鉴权失败（404）时，主体 / IP / 表单校验 / run 都不会执行", async () => {
    const parse = vi.fn((v: unknown) => v);
    const { calls, define } = setup({
      requireAdmin: async () => {
        calls.push("requireAdmin");
        notFound();
      },
    });
    const run = vi.fn(async () => undefined);
    const r = await outcome(
      define({
        name: "t",
        auth: { admin: "admin.roles" },
        input: z.any().transform(parse),
        run,
      })(form()),
    );
    expect(r.kind).toBe("notFound");
    expect(calls).toEqual(["requireAdmin"]);
    expect(parse).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("admin：ctx 的 userId / ip / admin 来自 requireAdmin 的结果", async () => {
    const { define } = setup();
    const run = vi.fn(async () => undefined);
    await define({ name: "t", auth: { admin: "admin.roles" }, run })(form());
    const ctx = (run.mock.calls[0] as unknown[])[0] as {
      userId: number;
      ip: string;
      admin: { userId: number };
    };
    expect(ctx).toMatchObject({ userId: 99, ip: "198.51.100.1", admin: { userId: 99 } });
  });
});

describe("输入校验（zod）", () => {
  const input = z.object({
    id: z.string().regex(/^\d+$/).transform(Number),
    note: z.string().max(5).optional(),
  });

  it("合法输入：run 拿到转换后的类型化数据；未声明的字段被剥掉", async () => {
    const { define } = setup();
    const run = vi.fn(async () => undefined);
    await define({ name: "t", auth: "user", input, run })(
      form({ id: "42", note: "hi", evil: "x" }),
    );
    expect((run.mock.calls[0] as unknown[])[1]).toEqual({ id: 42, note: "hi" });
  });

  it("非法输入（缺字段 / 类型不符 / 超长）一律 404，run 不执行；不泄露校验细节", async () => {
    for (const bad of [{}, { id: "abc" }, { id: "1", note: "toolong" }] as Record<
      string,
      string
    >[]) {
      const { define } = setup();
      const run = vi.fn(async () => undefined);
      const r = await outcome(define({ name: "t", auth: "user", input, run })(form(bad)));
      expect(r.kind, JSON.stringify(bad)).toBe("notFound");
      expect(run).not.toHaveBeenCalled();
    }
  });

  it("文件字段不会混进输入：即使表单里有名为 id 的文件，也按缺失处理", async () => {
    const { define } = setup();
    const run = vi.fn(async () => undefined);
    const f = new FormData();
    f.append("id", new File(["1"], "id.txt"));
    expect((await outcome(define({ name: "t", auth: "user", input, run })(f))).kind).toBe(
      "notFound",
    );
  });

  it("未声明 input：run 的输入为 undefined", async () => {
    const { define } = setup();
    const run = vi.fn(async () => undefined);
    await define({ name: "t", auth: "user", run })(form({ any: "thing" }));
    expect((run.mock.calls[0] as unknown[])[1]).toBeUndefined();
  });
});

describe("频控", () => {
  const onLimit = () => redirect("/limited");

  it("未超限正常执行；超限交给该条的 onLimit，run 不执行", async () => {
    let allowed = true;
    const { define } = setup({ rateLimit: () => ({ allowed }) });
    const run = vi.fn(async () => undefined);
    const act = define({
      name: "t",
      auth: "user",
      rateLimit: [{ key: () => "k", max: 1, windowMs: 1000, onLimit }],
      run,
    });
    expect((await outcome(act(form()))).kind).toBe("returned");
    expect(run).toHaveBeenCalledTimes(1);
    allowed = false;
    expect(await outcome(act(form()))).toEqual({ kind: "redirect", to: "/limited" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("键、上限、窗口按声明传给限流器；键可依赖上下文与输入", async () => {
    const seen: [string, number, number][] = [];
    const { define } = setup({
      rateLimit: (k, max, w) => {
        seen.push([k, max, w]);
        return { allowed: true };
      },
    });
    await define({
      name: "t",
      auth: "user",
      input: z.object({ tid: z.string() }),
      rateLimit: [
        { key: (c, i) => `reply:${c.userId}:${i.tid}`, max: 5, windowMs: 60_000, onLimit },
      ],
      run: async () => {},
    })(form({ tid: "9" }));
    expect(seen).toEqual([["reply:7:9", 5, 60_000]]);
  });

  it("key 返回 null 表示不适用（如取不到可信 IP 的 IP 级限额）：跳过，不调用限流器", async () => {
    const rl = vi.fn(() => ({ allowed: false }));
    const { define } = setup({ rateLimit: rl });
    const run = vi.fn(async () => undefined);
    await define({
      name: "t",
      auth: "user",
      rateLimit: [{ key: () => null, max: 1, windowMs: 1, onLimit }],
      run,
    })(form());
    expect(rl).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalled();
  });

  it("多条策略按声明顺序检查：先超限的那条处理；之后的不再检查", async () => {
    const checked: string[] = [];
    const { define } = setup({
      rateLimit: (k) => {
        checked.push(k);
        return { allowed: k !== "b" };
      },
    });
    const r = await outcome(
      define({
        name: "t",
        auth: "user",
        rateLimit: [
          { key: () => "a", max: 1, windowMs: 1, onLimit: () => redirect("/a") },
          { key: () => "b", max: 1, windowMs: 1, onLimit: () => redirect("/b") },
          { key: () => "c", max: 1, windowMs: 1, onLimit: () => redirect("/c") },
        ],
        run: async () => {},
      })(form()),
    );
    expect(r).toEqual({ kind: "redirect", to: "/b" });
    expect(checked).toEqual(["a", "b"]);
  });

  it("fail-closed：onLimit 没有抛出控制流异常（写错了）也不放行，按 404 拒绝", async () => {
    const { define } = setup({ rateLimit: () => ({ allowed: false }) });
    const run = vi.fn(async () => undefined);
    const r = await outcome(
      define({
        name: "t",
        auth: "user",
        rateLimit: [{ key: () => "k", max: 1, windowMs: 1, onLimit: (() => undefined) as never }],
        run,
      })(form()),
    );
    expect(r.kind).toBe("notFound");
    expect(run).not.toHaveBeenCalled();
  });

  it("输入非法的请求不占频控名额（校验先于频控）", async () => {
    const rl = vi.fn(() => ({ allowed: true }));
    const { define } = setup({ rateLimit: rl });
    await outcome(
      define({
        name: "t",
        auth: "user",
        input: z.object({ id: z.string().regex(/^\d+$/) }),
        rateLimit: [{ key: () => "k", max: 1, windowMs: 1, onLimit }],
        run: async () => {},
      })(form({ id: "x" })),
    );
    expect(rl).not.toHaveBeenCalled();
  });
});

describe("异常处理", () => {
  it("run 里的 redirect() / notFound() 原样传出（不被吞、不当成错误记录）", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { define } = setup();
      expect(
        await outcome(define({ name: "t", auth: "user", run: async () => redirect("/x") })(form())),
      ).toEqual({ kind: "redirect", to: "/x" });
      expect(
        (await outcome(define({ name: "t", auth: "user", run: async () => notFound() })(form())))
          .kind,
      ).toBe("notFound");
      expect(err).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });

  it("意外异常：记录动作名后原样抛出，不转成跳转也不吞掉", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { define } = setup();
      const boom = new Error("数据库挂了");
      const r = await outcome(
        define({
          name: "post.reply",
          auth: "user",
          run: async () => {
            throw boom;
          },
        })(form()),
      );
      expect(r).toEqual({ kind: "threw", error: boom });
      expect(String(err.mock.calls[0]![0])).toContain("post.reply");
    } finally {
      err.mockRestore();
    }
  });

  it("onLimit 里的跳转同样原样传出", async () => {
    const { define } = setup({ rateLimit: () => ({ allowed: false }) });
    const r = await outcome(
      define({
        name: "t",
        auth: "user",
        rateLimit: [{ key: () => "k", max: 1, windowMs: 1, onLimit: () => redirect("/slow-down") }],
        run: async () => {},
      })(form()),
    );
    expect(r).toEqual({ kind: "redirect", to: "/slow-down" });
  });
});

describe("真实导出", () => {
  it("导入 defineAction 就求值了模块注册表（硬约定 9）：注册表里有模块", () => {
    expect(typeof realDefineAction).toBe("function");
    expect(getModules().length).toBeGreaterThan(0);
  });

  it("产物是 (formData) => Promise<void>，可直接用作 <form action>", () => {
    const action = realDefineAction({ name: "t", auth: "guest", run: async () => {} });
    expect(typeof action).toBe("function");
    expect(action.length).toBe(1);
  });
});
