import { splitByGatePlaceholders } from "@funwind/content";
import type { GateView } from "@/lib/gates/types";
import { GateBlock } from "./gate-block";
import { RichContent } from "./rich-content";

/**
 * 帖子正文：按门控占位切分（packages/content），md 段走净化管线，gate 段交给 GateBlock。
 * 无门控的帖子（has_gate=false）跳过切分，直接整段渲染。
 * gates 由 lib/gates/service 的 loadGateViews 按观众预先判定；正文里的占位在 gates 中查不到时，
 * GateBlock 渲染“数据异常”（失败即封闭）。
 */
export function PostBody({
  md,
  hasGate,
  gates,
  pointsName,
  returnPage,
}: {
  md: string | null;
  hasGate: boolean;
  gates?: ReadonlyMap<string, GateView>;
  pointsName: string;
  returnPage?: number;
}) {
  if (!hasGate || !md) return <RichContent md={md} />;
  return (
    <>
      {splitByGatePlaceholders(md).map((seg, i) =>
        seg.kind === "md" ? (
          seg.text.trim() === "" ? null : (
            <RichContent key={i} md={seg.text} />
          )
        ) : (
          <GateBlock
            key={i}
            view={gates?.get(seg.key)}
            pointsName={pointsName}
            returnPage={returnPage}
          />
        ),
      )}
    </>
  );
}
