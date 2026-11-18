import type { ChapterSummary } from "../../../../shared/contracts";

const STATUS_LABELS: Record<string, string> = {
  final: "终稿",
  "ai-revised": "AI 修订",
  "human-revising": "人工修订",
  draft: "草稿",
};

/** 返回章节状态的作者可读名称；未知状态保留原值，避免隐藏仓库异常。 */
export function chapterStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

/** 按原始章号、三位章号、章节 ID、标题或状态匹配。 */
export function chapterMatchesQuery(
  chapter: ChapterSummary,
  query: string,
): boolean {
  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  if (!normalized) return true;
  const padded = String(chapter.number).padStart(3, "0");
  return [
    String(chapter.number),
    padded,
    chapter.id,
    chapter.title,
    chapter.status,
    chapterStatusLabel(chapter.status),
  ].some((value) => value.toLocaleLowerCase("zh-CN").includes(normalized));
}

/** 同时应用全文查询和精确状态筛选。 */
export function chapterMatchesFilters(
  chapter: ChapterSummary,
  query: string,
  status: string,
): boolean {
  return (
    (status === "all" || chapter.status === status) &&
    chapterMatchesQuery(chapter, query)
  );
}
