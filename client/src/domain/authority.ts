import type { ContextCandidate } from "../../../shared/contracts";

export function authorityLabel(
  authority: ContextCandidate["authority"],
): string {
  return (
    {
      canonical: "正式正文",
      bible: "当前圣经",
      "approved-plan": "已批准规划",
      plan: "普通规划",
      production: "生产工件",
      review: "审稿记录",
      material: "素材",
      archive: "归档",
    } as const
  )[authority];
}
