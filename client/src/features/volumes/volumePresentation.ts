import type {
  ChapterStatus,
  VolumeRelatedRecord,
} from "../../../../shared/contracts";

const STATUS_LABELS: Record<string, string> = {
  final: "终稿",
  "ai-revised": "AI 修订",
  "human-revising": "人工修订",
  draft: "草稿",
  unknown: "状态未知",
};

const STATUS_ORDER = ["final", "ai-revised", "human-revising", "draft"];

export interface StatusCountPresentation {
  status: ChapterStatus;
  label: string;
  count: number;
}

/** 将服务端状态汇总转换为顺序稳定、未知状态也不丢失的展示数据。 */
export function presentStatusCounts(
  statusCounts: Readonly<Record<string, number>>,
): StatusCountPresentation[] {
  return Object.entries(statusCounts)
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => {
      const leftIndex = STATUS_ORDER.indexOf(left);
      const rightIndex = STATUS_ORDER.indexOf(right);
      if (leftIndex < 0 && rightIndex < 0)
        return left.localeCompare(right, "zh-CN");
      if (leftIndex < 0) return 1;
      if (rightIndex < 0) return -1;
      return leftIndex - rightIndex;
    })
    .map(([status, count]) => ({
      status,
      label: STATUS_LABELS[status] ?? status,
      count,
    }));
}

export function relatedRecordKindLabel(
  kind: VolumeRelatedRecord["kind"],
): string {
  return {
    review: "审稿",
    production: "生产",
    publication: "发布",
  }[kind];
}

export function lifecycleLabel(
  lifecycle: "planned" | "active" | "archived",
): string {
  return {
    planned: "规划中",
    active: "创作中",
    archived: "已归档",
  }[lifecycle];
}
