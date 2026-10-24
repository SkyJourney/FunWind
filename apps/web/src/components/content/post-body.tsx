import { splitByGatePlaceholders } from "@funwind/content";
import { GateSlot } from "./gate-slot";
import { RichContent } from "./rich-content";

/**
 * 帖子正文：按门控占位切分（packages/content），md 段走净化管线，gate 段交给 GateSlot。
 * 无门控的帖子（has_gate=false）跳过切分，直接整段渲染。
 */
export function PostBody({ md, hasGate }: { md: string | null; hasGate: boolean }) {
  if (!hasGate || !md) return <RichContent md={md} />;
  return (
    <>
      {splitByGatePlaceholders(md).map((seg, i) =>
        seg.kind === "md" ? (
          seg.text.trim() === "" ? null : (
            <RichContent key={i} md={seg.text} />
          )
        ) : (
          <GateSlot key={i} gateKey={seg.key} />
        ),
      )}
    </>
  );
}
