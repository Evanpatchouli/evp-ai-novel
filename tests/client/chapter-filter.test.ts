import { describe, expect, it } from "vitest";
import type { ChapterSummary } from "../../shared/contracts.js";
import {
  chapterMatchesFilters,
  chapterMatchesQuery,
  chapterStatusLabel,
} from "../../client/src/features/chapters/chapterFilter.js";

const chapter: ChapterSummary = {
  id: "ch016",
  number: 16,
  title: "第十六章 焦枝之下",
  path: "40_正文/卷/v01/章节/ch016.md",
  status: "ai-revised",
  humanApproved: false,
  reviewGate: "pending-human-review",
  wordCount: 1318,
  lengthFlag: "normal",
};

describe("chapterMatchesQuery", () => {
  it.each([
    "16",
    "016",
    "ch016",
    "焦枝",
    "第十六章",
    "ai-revised",
    "AI 修订",
    "",
  ])("匹配查询 %s", (query) => {
    expect(chapterMatchesQuery(chapter, query)).toBe(true);
  });

  it("拒绝无关查询", () => {
    expect(chapterMatchesQuery(chapter, "星海尽头")).toBe(false);
  });

  it("同时应用状态过滤", () => {
    expect(chapterMatchesFilters(chapter, "焦枝", "ai-revised")).toBe(true);
    expect(chapterMatchesFilters(chapter, "焦枝", "final")).toBe(false);
    expect(chapterMatchesFilters(chapter, "焦枝", "all")).toBe(true);
  });

  it("未知状态保留原值", () => {
    expect(chapterStatusLabel("custom-review")).toBe("custom-review");
  });
});
