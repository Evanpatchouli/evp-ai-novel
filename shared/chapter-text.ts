export type ChapterLineEnding = "lf" | "crlf";

export interface ChapterMarkdownAnalysis {
  valid: boolean;
  title: string;
  wordCount: number;
  lineCount: number;
  lineEnding: ChapterLineEnding;
  errors: string[];
}

/** 以正文阅读口径统计汉字与英文/数字词，忽略 YAML frontmatter 和首个 H1。 */
export function countChapterWords(markdown: string): number {
  const body = markdown
    .replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, "")
    .replace(/^#\s+.*(?:\r?\n|$)/, "");
  const han = body.match(/[\p{Script=Han}]/gu)?.length ?? 0;
  const words = body.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g)?.length ?? 0;
  return han + words;
}

/** 检查章节 Markdown 的编码标记、唯一首行 H1、大小与基础文本安全边界。 */
export function analyzeChapterMarkdown(
  markdown: string,
  maxLength = 2_000_000,
): ChapterMarkdownAnalysis {
  const errors: string[] = [];
  if (markdown.startsWith("\uFEFF")) errors.push("正文不能包含 UTF-8 BOM");
  if (markdown.includes("\0")) errors.push("正文不能包含 NUL 字符");
  if (markdown.length > maxLength) errors.push("正文超过允许的最大长度");

  const headings = [...markdown.matchAll(/^#\s+([^\r\n]+)$/gm)];
  const firstContent = markdown.split(/\r?\n/).find((line) => line.trim());
  const title = headings[0]?.[1]?.trim() ?? "";
  if (!title) errors.push("章节必须包含非空的一级标题");
  if (headings.length > 1) errors.push("章节只能包含一个一级标题");
  if (firstContent !== headings[0]?.[0])
    errors.push("一级标题必须是正文首个非空内容");

  return {
    valid: errors.length === 0,
    title,
    wordCount: countChapterWords(markdown),
    lineCount: markdown ? markdown.split(/\r?\n/).length : 0,
    lineEnding: markdown.includes("\r\n") ? "crlf" : "lf",
    errors,
  };
}

/** 将浏览器提交的换行统一为目标文件原有约定。 */
export function normalizeChapterLineEndings(
  markdown: string,
  lineEnding: ChapterLineEnding,
): string {
  const normalized = markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return lineEnding === "crlf" ? normalized.replace(/\n/g, "\r\n") : normalized;
}
