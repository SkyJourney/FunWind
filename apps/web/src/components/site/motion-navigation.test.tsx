import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type Link from "next/link";
import { MotionLink, useMotionRouter } from "./motion-navigation";

const mocks = vi.hoisted(() => ({
  pathname: "/a",
  begin: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  refresh: vi.fn(),
  prefetch: vi.fn(),
  types: [] as string[],
}));
vi.mock("./motion-provider", () => ({ useSiteMotion: () => ({ begin: mocks.begin }) }));
vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({
    push: mocks.push,
    replace: mocks.replace,
    back: mocks.back,
    forward: mocks.forward,
    refresh: mocks.refresh,
    prefetch: mocks.prefetch,
  }),
}));
vi.mock("next/link", () => ({
  default: ({ href, transitionTypes, children, ...props }: ComponentProps<typeof Link>) => {
    mocks.types = transitionTypes ?? [];
    return (
      <a {...props} href={typeof href === "string" ? href : (href.pathname ?? "")}>
        {children}
      </a>
    );
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.pathname = "/a";
  mocks.types = [];
});
function RouterHarness() {
  const router = useMotionRouter();
  return (
    <>
      <button onClick={() => router.push("/a/901", { scroll: false })}>push</button>
      <button
        onClick={() =>
          router.replace("/a/901", { direction: "pop", transitionTypes: ["extra", "fw-pop"] })
        }
      >
        replace
      </button>
      <button onClick={() => router.push("/a/901")}>default</button>
      <button onClick={() => router.back()}>back</button>
      <button onClick={() => router.forward()}>forward</button>
      <button onClick={() => router.refresh()}>refresh</button>
    </>
  );
}
it("MotionLink默认按新注册表选types，href/DOM语义保留，不伪造显式hint", () => {
  render(<MotionLink href="/a/901">详情</MotionLink>);
  expect(screen.getByRole("link", { name: "详情" }).getAttribute("href")).toBe("/a/901");
  expect(screen.getByRole("link").hasAttribute("data-motion-direction")).toBe(false);
  expect(mocks.types).toEqual(["fw-push"]);
});
it("显式hint与Next transitionTypes都透传并去重", () => {
  render(
    <MotionLink href="/a/901" direction="pop" transitionTypes={["fw-pop", "extra"]}>
      返回
    </MotionLink>,
  );
  expect(screen.getByRole("link").getAttribute("data-motion-direction")).toBe("pop");
  expect(mocks.types).toEqual(["fw-pop", "extra"]);
});
it("对象形式href取pathname，未指定pathname按同页fade", () => {
  const { rerender } = render(
    <MotionLink href={{ pathname: "/a/901", query: { x: 1 } }}>详情</MotionLink>,
  );
  expect(mocks.types).toEqual(["fw-push"]);
  rerender(<MotionLink href={{ query: { x: 1 } }}>筛选</MotionLink>);
  expect(mocks.types).toEqual(["fw-fade"]);
});
it("push先登记guard再转发scroll与types", () => {
  render(<RouterHarness />);
  fireEvent.click(screen.getByText("push"));
  expect(mocks.begin).toHaveBeenCalledWith("/a/901", undefined);
  expect(mocks.push).toHaveBeenCalledWith("/a/901", {
    scroll: false,
    transitionTypes: ["fw-push"],
  });
  expect(mocks.begin.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.push.mock.invocationCallOrder[0]!,
  );
});
it("被更新导航取代时不能再派发旧router动作", () => {
  mocks.begin.mockReturnValueOnce(false);
  render(<RouterHarness />);
  fireEvent.click(screen.getByText("push"));
  expect(mocks.push).not.toHaveBeenCalled();
});
it("replace透传显式方向和扩展types，不把direction传给Next", () => {
  render(<RouterHarness />);
  fireEvent.click(screen.getByText("replace"));
  expect(mocks.begin).toHaveBeenCalledWith("/a/901", "pop");
  expect(mocks.replace).toHaveBeenCalledWith("/a/901", { transitionTypes: ["fw-pop", "extra"] });
});
it("无options时使用默认解析，history/refresh仍调用原路由方法，不伪造点击会话", () => {
  render(<RouterHarness />);
  fireEvent.click(screen.getByText("default"));
  expect(mocks.push).toHaveBeenCalledWith("/a/901", { transitionTypes: ["fw-push"] });
  mocks.begin.mockClear();
  for (const method of ["back", "forward", "refresh"] as const) {
    fireEvent.click(screen.getByText(method));
    expect(mocks[method]).toHaveBeenCalledOnce();
  }
  expect(mocks.begin).not.toHaveBeenCalled();
});
