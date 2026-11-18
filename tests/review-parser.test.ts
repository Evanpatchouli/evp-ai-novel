import { describe, expect, it } from "vitest";
import { parseReviewIssues } from "../server/tasks.js";

describe("结构化审稿报告解析", () => {
  it("把一个问题下的证据、影响和建议解析为同一条代办项", () => {
    const raw = `# 一、阻断问题

## 1. 人物在知情前使用了关键情报

**证据**
- \`ch016:11—13\`：人物准确说出了药物名称。
- \`ch015:88\`：人物只知道有人受伤。

**影响**
信息来源断裂，读者无法判断人物为何知情。

**建议**
补充情报传递节点，或改为不依赖药名的判断。
`;

    expect(parseReviewIssues(raw)).toEqual([
      expect.objectContaining({
        id: "issue-001",
        severity: "blocker",
        title: "人物在知情前使用了关键情报",
        evidence: [
          "`ch016:11—13`：人物准确说出了药物名称。",
          "`ch015:88`：人物只知道有人受伤。",
        ],
        impact: "信息来源断裂，读者无法判断人物为何知情。",
        suggestion: "补充情报传递节点，或改为不依赖药名的判断。",
      }),
    ]);
  });

  it("不会把十个问题内部的列表拆成额外代办项", () => {
    const severities = [
      ["阻断问题", 2],
      ["重要问题", 5],
      ["轻微问题", 3],
    ] as const;
    let number = 0;
    const raw = severities
      .map(([severity, count]) => {
        const issues = Array.from({ length: count }, () => {
          number += 1;
          return `## ${number}. 问题 ${number}
**证据**
- 证据 A
- 证据 B
**影响**
- 影响 A
- 影响 B
**建议**
- 建议 A
- 建议 B`;
        }).join("\n\n");
        return `# ${severity}\n\n${issues}`;
      })
      .join("\n\n");

    const issues = parseReviewIssues(raw);

    expect(issues).toHaveLength(10);
    expect(issues[0]).toMatchObject({
      severity: "blocker",
      evidence: ["证据 A", "证据 B"],
      impact: "- 影响 A\n- 影响 B",
      suggestion: "- 建议 A\n- 建议 B",
    });
    expect(issues[9]?.severity).toBe("minor");
  });
});
