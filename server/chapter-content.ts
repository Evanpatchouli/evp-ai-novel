import { analyzeChapterMarkdown } from "../shared/chapter-text.js";
import { AppError, assert } from "./errors.js";

/** 校验可写入正式章节的 Markdown 结构，并返回权威标题分析结果。 */
export function validateChapterContent(content: string) {
  const analysis = analyzeChapterMarkdown(content);
  if (content.startsWith("\uFEFF")) {
    throw new AppError("CHAPTER_BOM_NOT_ALLOWED", "章节正文不能包含 UTF-8 BOM");
  }
  assert(analysis.valid, "INVALID_CHAPTER_CONTENT", analysis.errors.join("；"));
  return analysis;
}
