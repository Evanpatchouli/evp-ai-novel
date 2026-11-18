/** @vitest-environment jsdom */
import { useCallback, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewIssue } from "../../shared/contracts.js";
import type { TaskDetail } from "../../client/src/api.js";

const markdownRenderCounts = vi.hoisted(() => new Map<string, number>());

vi.mock("../../client/src/components/MarkdownContent.js", () => ({
  MarkdownContent({ children }: { children: string }) {
    markdownRenderCounts.set(
      children,
      (markdownRenderCounts.get(children) ?? 0) + 1,
    );
    return <span>{children}</span>;
  },
}));

import { ReviewIssueList } from "../../client/src/features/workflow/ReviewIssueList.js";
import { useWorkflowController } from "../../client/src/features/workflow/useWorkflowController.js";

const ISSUES: ReviewIssue[] = [
  {
    id: "issue-1",
    severity: "blocker",
    title: "第一项标题",
    detail: "第一项详情",
    evidence: ["第一项证据"],
    impact: "第一项影响",
    suggestion: "第一项建议",
    decision: "later",
  },
  {
    id: "issue-2",
    severity: "important",
    title: "第二项标题",
    detail: "第二项详情",
    evidence: ["第二项证据"],
    impact: "第二项影响",
    suggestion: "第二项建议",
    decision: "later",
  },
];

afterEach(() => {
  cleanup();
  markdownRenderCounts.clear();
});

describe("ReviewIssueList", () => {
  it("更新一项备注时不重新渲染其他问题卡片", () => {
    function Harness() {
      const [issues, setIssues] = useState(ISSUES);
      const updateIssue = useCallback(
        (index: number, patch: Partial<ReviewIssue>) => {
          setIssues((current) =>
            current.map((issue, issueIndex) =>
              issueIndex === index ? { ...issue, ...patch } : issue,
            ),
          );
        },
        [],
      );
      return <ReviewIssueList issues={issues} updateIssue={updateIssue} />;
    }

    render(<Harness />);
    const firstTitleRenderCount = markdownRenderCounts.get("第一项标题");
    const secondTitleRenderCount = markdownRenderCounts.get("第二项标题");

    fireEvent.change(
      screen.getByRole("textbox", { name: "第一项标题的决策备注" }),
      { target: { value: "需要补充说明" } },
    );

    expect(markdownRenderCounts.get("第一项标题")).toBeGreaterThan(
      firstTitleRenderCount ?? 0,
    );
    expect(markdownRenderCounts.get("第二项标题")).toBe(secondTitleRenderCount);
  });

  it("决策区使用顶部可见标签和两行备注输入", () => {
    render(<ReviewIssueList issues={[ISSUES[0]]} updateIssue={vi.fn()} />);

    const decisionRow = screen.getByText("处理决定").closest(".decision-row");
    expect(decisionRow).not.toBeNull();
    expect(decisionRow?.contains(screen.getByText("决策备注"))).toBe(true);
    expect(
      screen.getByRole("textbox", { name: "第一项标题的决策备注" }),
    ).toHaveProperty("rows", 2);
  });

  it("问题状态更新后保持 updateIssue 回调引用稳定", () => {
    const task = {
      id: "task-1",
      stage: "review-imported",
      issues: ISSUES,
    } as TaskDetail;
    const { result } = renderHook(() =>
      useWorkflowController(task, vi.fn(), vi.fn()),
    );
    const initialUpdateIssue = result.current.updateIssue;

    act(() => result.current.updateIssue(0, { decisionNote: "新的备注" }));

    expect(result.current.updateIssue).toBe(initialUpdateIssue);
  });
});
