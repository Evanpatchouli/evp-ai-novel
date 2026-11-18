import type { ChapterLink } from "../../../../shared/contracts";
import { chapterHref } from "../../../../shared/reader-paths";

/** 构造可刷新、可复制的章节详情地址。 */
export function chapterDetailHref(chapter: ChapterLink): string {
  return chapterHref(chapter.volumeId, chapter.chapterId);
}

/**
 * 阅读页标题已经展示权威 H1，因此只移除正文开头的第一个 H1。
 * 正文中后续出现的 H1 会原样保留，避免静默改变章节内容的阅读语义。
 */
export function stripLeadingChapterH1(markdown: string): string {
  const match =
    /^(?:\uFEFF)?(?:[\t ]*\r?\n)*[\t ]*#(?!#)[\t ]+[^\r\n]+(?:\r?\n)?/.exec(
      markdown,
    );
  if (!match) return markdown;
  return markdown.slice(match[0].length).replace(/^(?:[\t ]*\r?\n)+/, "");
}
