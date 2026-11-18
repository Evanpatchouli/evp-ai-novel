import { describe, expect, it } from "vitest";
import {
  analyzeChapterMarkdown,
  countChapterWords,
  normalizeChapterLineEndings,
} from "../shared/chapter-text.js";

describe("章节 Markdown 纯函数", () => {
  it("使用与阅读索引一致的中英文混合字数口径", () => {
    expect(countChapterWords("# 标题\n\n长青 hello-world 42。\n")).toBe(4);
  });

  it("要求唯一 H1 是首个非空内容并拒绝 BOM 与 NUL", () => {
    expect(analyzeChapterMarkdown("# 第一章\n\n正文")).toMatchObject({
      valid: true,
      title: "第一章",
      wordCount: 2,
    });
    expect(analyzeChapterMarkdown("前言\n# 第一章\n").valid).toBe(false);
    expect(analyzeChapterMarkdown("# 第一章\n# 第二章\n").valid).toBe(false);
    expect(analyzeChapterMarkdown("\uFEFF# 第一章\n").valid).toBe(false);
    expect(analyzeChapterMarkdown("# 第一章\n\0").valid).toBe(false);
  });

  it("按原文件约定规范化换行", () => {
    expect(normalizeChapterLineEndings("# 标题\r\n正文\n", "lf")).toBe(
      "# 标题\n正文\n",
    );
    expect(normalizeChapterLineEndings("# 标题\n正文\n", "crlf")).toBe(
      "# 标题\r\n正文\r\n",
    );
  });
});
