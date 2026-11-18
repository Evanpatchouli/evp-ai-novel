import { describe, expect, it } from "vitest";
import type { TaskDetail } from "../../client/src/api.js";
import {
  createWorkflowState,
  STYLE_REFINEMENT_INSTRUCTION,
  workflowStateReducer,
} from "../../client/src/features/workflow/workflowState.js";

describe("workflowState", () => {
  it("从任务详情恢复已记录的上下文候选资料", () => {
    const context = [
      {
        path: "40_正文/章节/ch002.md",
        label: "当前章",
        authority: "canonical" as const,
        selected: true,
        reason: "检查章节内容与衔接",
      },
      {
        path: "20_规划/卷纲.md",
        label: "卷纲",
        authority: "plan" as const,
        selected: false,
        reason: "定位本卷意图",
      },
    ];

    const state = createWorkflowState({ id: "task-a", context } as TaskDetail);

    expect(state.context).toEqual(context);
  });

  it("换任务时清空上一任务的草稿、上下文和预览", () => {
    const first = {
      id: "task-a",
      prompt: "旧提示词",
      reviewRaw: "旧审稿",
      revisionRaw: "旧修订",
    } as TaskDetail;
    const second = { id: "task-b", prompt: "新提示词" } as TaskDetail;
    const dirty = {
      ...createWorkflowState(first),
      context: [{ path: "old.md" }],
      preview: { token: "old-token" },
    } as ReturnType<typeof createWorkflowState>;
    const reset = workflowStateReducer(dirty, { type: "reset", task: second });

    expect(reset.taskId).toBe("task-b");
    expect(reset.prompt).toBe("新提示词");
    expect(reset.reviewText).toBe("");
    expect(reset.revisionText).toBe("");
    expect(reset.context).toEqual([]);
    expect(reset.preview).toBeNull();
  });

  it("批量决定所有问题时保留已有决策备注", () => {
    const state = createWorkflowState({
      id: "task-decisions",
      issues: [
        { id: "issue-a", decision: "later", decisionNote: "保留这条备注" },
        { id: "issue-b", decision: "partially-approved" },
      ],
    } as TaskDetail);

    const approved = workflowStateReducer(state, {
      type: "set-all-decisions",
      decision: "approved",
    });
    const rejected = workflowStateReducer(approved, {
      type: "set-all-decisions",
      decision: "rejected",
    });

    expect(approved.issues.map((issue) => issue.decision)).toEqual([
      "approved",
      "approved",
    ]);
    expect(rejected.issues.map((issue) => issue.decision)).toEqual([
      "rejected",
      "rejected",
    ]);
    expect(rejected.issues[0]?.decisionNote).toBe("保留这条备注");
  });

  it("可一次选中全部五项终稿确认", () => {
    const state = createWorkflowState({
      id: "task-confirmation",
    } as TaskDetail);

    const confirmed = workflowStateReducer(state, { type: "confirm-all" });

    expect(Object.values(confirmed.confirmation)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it("通过工作台 UI 状态加入全篇文风润色要求", () => {
    const state = createWorkflowState({ id: "task-style" } as TaskDetail);
    const enabled = workflowStateReducer(state, {
      type: "toggle-revision-instruction",
      instruction: STYLE_REFINEMENT_INSTRUCTION,
      checked: true,
    });
    const disabled = workflowStateReducer(enabled, {
      type: "toggle-revision-instruction",
      instruction: STYLE_REFINEMENT_INSTRUCTION,
      checked: false,
    });

    expect(enabled.revisionInstructionAdditions).toEqual([
      STYLE_REFINEMENT_INSTRUCTION,
    ]);
    expect(disabled.revisionInstructionAdditions).toEqual([]);
  });
});
