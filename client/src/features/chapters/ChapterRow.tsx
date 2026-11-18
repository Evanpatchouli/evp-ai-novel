import { Chip } from "@ldkj/web-ui";
import { Link } from "react-router";
import type { ChapterSummary } from "../../../../shared/contracts";
import { chapterHref } from "../../../../shared/reader-paths";
import { chapterStatusLabel } from "./chapterFilter";

export function StatusChip({ status }: { status: string }) {
  const variant =
    status === "final"
      ? "success"
      : status === "ai-revised"
        ? "warning"
        : "default";
  return (
    <Chip size="sm" variant={variant}>
      {chapterStatusLabel(status)}
    </Chip>
  );
}

export function ChapterRow({
  volumeId,
  chapter,
}: {
  volumeId: string;
  chapter: ChapterSummary;
}) {
  const lengthLabel =
    chapter.lengthFlag === "short"
      ? "偏短"
      : chapter.lengthFlag === "long"
        ? "偏长"
        : "";

  return (
    <Link
      className="chapter-row"
      to={chapterHref(volumeId, chapter.id)}
    >
      <span className="chapter-number">
        {String(chapter.number).padStart(3, "0")}
      </span>
      <span className="chapter-title">{chapter.title}</span>
      <span
        className={`length-flag ${chapter.lengthFlag}`}
        aria-label={`篇幅：${chapter.wordCount.toLocaleString()} 字${lengthLabel ? `，${lengthLabel}` : ""}`}
      >
        {chapter.wordCount.toLocaleString()} 字
        {lengthLabel ? ` · ${lengthLabel}` : ""}
      </span>
      <StatusChip status={chapter.status} />
    </Link>
  );
}
