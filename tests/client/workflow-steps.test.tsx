/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskDetail } from "../../client/src/api.js";
import { WorkflowSteps } from "../../client/src/features/workflow/WorkflowSteps.js";
import {
  createWorkflowState,
  STYLE_REFINEMENT_INSTRUCTION,
} from "../../client/src/features/workflow/workflowState.js";
import type { WorkflowController } from "../../client/src/features/workflow/useWorkflowController.js";
import type { TaskStage } from "../../shared/contracts.js";

afterEach(cleanup);

describe("WorkflowSteps", () => {
  const PANEL_TITLES = [
    "准备 ChatGPT 审查任务包",
    "审查提示词",
    "导入审稿报告",
    "逐条作出人工决策",
    "修订提示词",
    "导入完整修订稿",
    "修订差异与风险",
    "人工终审稿",
    "终稿写入确认",
    "正式写入预览",
    "结束本轮任务",
    "任务已归档",
  ] as const;

  function workflow(stage: TaskStage) {
    const task = {
      id: "task-stage-test",
      directory: "30_生产/active/task-stage-test",
      stage,
      pendingDecisionCount: 2,
      prompt: stage === "context-ready" ? "审查提示词正文" : "修订提示词正文",
      revisionRaw: "# 第十六章\n\n修订稿",
      revisionAnalysis: {
        changes: [],
        addedRatio: 0.1,
        removedRatio: 0.05,
        titleChanged: false,
        possibleNewCanon: [],
        continuityWarnings: [],
        largeUnapprovedRewrite: false,
      },
    } as TaskDetail;
    const controller = {
      state: createWorkflowState(task),
      busy: "",
      error: "",
      loadContext: vi.fn(),
      buildContext: vi.fn(),
      toggleContext: vi.fn(),
      setReviewText: vi.fn(),
      importReview: vi.fn(),
      updateIssue: vi.fn(),
      setAllDecisions: vi.fn(),
      toggleRevisionInstruction: vi.fn(),
      saveDecisions: vi.fn(),
      buildRevisionPackage: vi.fn(),
      buildCompactRevisionPackage: vi.fn(),
      buildCompactTextRevisionPackage: vi.fn(),
      setRevisionText: vi.fn(),
      importRevision: vi.fn(),
      saveHumanFinal: vi.fn(),
      confirmFinal: vi.fn(),
      confirm: vi.fn(),
      confirmAll: vi.fn(),
      makePreview: vi.fn(),
      write: vi.fn(),
      archive: vi.fn(),
    } as unknown as WorkflowController;
    render(
      <WorkflowSteps task={task} controller={controller} notify={vi.fn()} />,
    );
    return controller;
  }

  it.each<[TaskStage, readonly string[]]>([
    ["created", ["准备 ChatGPT 审查任务包"]],
    ["context-ready", ["审查提示词", "导入审稿报告"]],
    ["review-imported", ["逐条作出人工决策"]],
    ["decisions-recorded", ["修订提示词", "导入完整修订稿"]],
    ["revision-imported", ["修订差异与风险", "人工终审稿"]],
    ["human-final-review", ["终稿写入确认"]],
    ["ready-to-write", ["正式写入预览"]],
    ["written", ["结束本轮任务"]],
    ["archived", ["任务已归档"]],
  ])("%s 只显示所属步骤面板", (stage, expected) => {
    workflow(stage);

    for (const title of PANEL_TITLES) {
      const heading = screen.queryByRole("heading", { name: title });
      if (expected.includes(title)) expect(heading).not.toBeNull();
      else expect(heading).toBeNull();
    }
  });

  it("人工终审阶段不再暴露服务端禁止的修订导入操作", () => {
    workflow("revision-imported");

    expect(screen.getByRole("button", { name: "保存人工终审稿" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "保存并分析差异" })).toBeNull();
  });

  it("第五步优先生成精简修订包并保留完整审计包", () => {
    const controller = workflow("decisions-recorded");

    expect(
      screen.getByText(
        "支持 ZIP 时优先使用精简包；DeepSeek 等不支持 ZIP 的平台使用单文件包。完整审计包仅用于追溯和复杂复核。",
      ),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "生成精简修订包（推荐）" }),
    );
    expect(controller.buildCompactRevisionPackage).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "生成完整审计包" }));
    expect(controller.buildRevisionPackage).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole("button", {
        name: "生成单文件包（DeepSeek 等）",
      }),
    );
    expect(controller.buildCompactTextRevisionPackage).toHaveBeenCalledTimes(1);
  });

  it.each(["context-ready", "decisions-recorded"] as const)(
    "%s 使用双栏交接布局和明确的步骤操作区",
    (stage) => {
      workflow(stage);

      expect(document.querySelector(".workflow-handoff-grid")).not.toBeNull();
      expect(document.querySelectorAll(".workflow-handoff-panel")).toHaveLength(
        2,
      );
      expect(document.querySelector(".workflow-step-actions")).not.toBeNull();
    },
  );

  it("人工决策显示处理进度并可定位下一条未处理问题", () => {
    const scrollIntoView = vi.fn();
    const focus = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    HTMLElement.prototype.focus = focus;
    const task = {
      id: "task-decisions",
      directory: "30_生产/active/task-decisions",
      stage: "review-imported",
      pendingDecisionCount: 1,
      issues: [
        {
          id: "resolved",
          severity: "minor",
          title: "已处理问题",
          decision: "approved",
        },
        {
          id: "pending",
          severity: "important",
          title: "待处理问题",
          decision: "later",
        },
      ],
    } as TaskDetail;
    const controller = {
      state: createWorkflowState(task),
      busy: "",
      error: "",
      updateIssue: vi.fn(),
      setAllDecisions: vi.fn(),
      saveDecisions: vi.fn(),
    } as unknown as WorkflowController;

    render(
      <WorkflowSteps task={task} controller={controller} notify={vi.fn()} />,
    );

    expect(screen.getByText("已处理 1 / 2")).toBeTruthy();
    expect(
      screen.getByRole("checkbox", { name: STYLE_REFINEMENT_INSTRUCTION }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "下一条未处理" }));
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
    expect(focus).toHaveBeenCalled();
  });

  it("人工决策可批量全部通过或全部拒绝，但不会自动保存", () => {
    const task = {
      id: "task-bulk-decisions",
      directory: "30_生产/active/task-bulk-decisions",
      stage: "review-imported",
      issues: [{ id: "pending", severity: "important", title: "待处理问题" }],
    } as TaskDetail;
    const controller = {
      state: createWorkflowState(task),
      busy: "",
      error: "",
      updateIssue: vi.fn(),
      setAllDecisions: vi.fn(),
      saveDecisions: vi.fn(),
    } as unknown as WorkflowController;

    render(
      <WorkflowSteps task={task} controller={controller} notify={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "全部通过" }));
    expect(controller.setAllDecisions).toHaveBeenCalledWith("approved");
    fireEvent.click(screen.getByRole("button", { name: "全部拒绝" }));
    expect(controller.setAllDecisions).toHaveBeenCalledWith("rejected");
    expect(controller.saveDecisions).not.toHaveBeenCalled();
  });

  it("四级严重度标签使用独立业务样式类", () => {
    const task = {
      id: "task-severity-chips",
      directory: "30_生产/active/task-severity-chips",
      stage: "review-imported",
      pendingDecisionCount: 4,
      issues: [
        { id: "blocker", severity: "blocker", title: "阻断问题" },
        { id: "important", severity: "important", title: "重要问题" },
        { id: "minor", severity: "minor", title: "轻微问题" },
        { id: "optional", severity: "optional", title: "可选问题" },
      ],
    } as TaskDetail;
    const controller = {
      state: createWorkflowState(task),
      busy: "",
      error: "",
      updateIssue: vi.fn(),
      saveDecisions: vi.fn(),
    } as unknown as WorkflowController;

    render(
      <WorkflowSteps task={task} controller={controller} notify={vi.fn()} />,
    );

    for (const [label, severity] of [
      ["阻断", "blocker"],
      ["重要", "important"],
      ["轻微", "minor"],
      ["可选", "optional"],
    ] as const) {
      expect(screen.getByText(label).classList).toContain(
        `severity-chip-${severity}`,
      );
    }
  });

  it("人工终审稿使用带状态说明的稳定操作区", () => {
    workflow("revision-imported");

    const actions = document.querySelector(
      ".workflow-step-actions.workflow-step-actions-sticky",
    );
    expect(actions?.textContent).toContain("人工终审稿已载入");
    expect(
      actions?.contains(screen.getByRole("button", { name: "保存人工终审稿" })),
    ).toBe(true);
  });

  it("终稿确认和正式写入分别位于第七、八步", () => {
    const controller = workflow("human-final-review");
    fireEvent.click(screen.getByRole("button", { name: "全选" }));
    expect(controller.confirmAll).toHaveBeenCalledTimes(1);
    expect(controller.confirmFinal).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "确认终稿并进入写入" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "生成写入预览" })).toBeNull();
    cleanup();

    workflow("ready-to-write");
    expect(screen.getByRole("button", { name: "生成写入预览" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "确认终稿并进入写入" }),
    ).toBeNull();
  });

  it.each([
    { pendingDecisionCount: 3, label: "3 项待决策" },
    { pendingDecisionCount: 0, label: "没有待决策项" },
  ])(
    "人工决策面板不重复页面级状态：$label",
    ({ pendingDecisionCount, label }) => {
      const task = {
        id: "task-1",
        directory: "30_生产/active/task-1",
        stage: "review-imported",
        pendingDecisionCount,
      } as TaskDetail;
      const controller = {
        state: createWorkflowState(task),
        busy: "",
        error: "",
        updateIssue: vi.fn(),
        saveDecisions: vi.fn(),
      } as unknown as WorkflowController;

      render(
        <WorkflowSteps task={task} controller={controller} notify={vi.fn()} />,
      );

      const panel = screen
        .getByRole("heading", { name: "逐条作出人工决策" })
        .closest("section");
      expect(panel).not.toBeNull();
      expect(panel?.textContent).not.toContain(label);
      expect(panel?.textContent).toContain("已处理 0 / 0");
    },
  );

  it("零条结构化问题时仍允许记录空人工决策", () => {
    const task = {
      id: "task-1",
      directory: "30_生产/active/task-1",
      stage: "review-imported",
    } as TaskDetail;
    const controller = {
      state: createWorkflowState(task),
      busy: "",
      error: "",
      setReviewText: vi.fn(),
      importReview: vi.fn(),
      updateIssue: vi.fn(),
      saveDecisions: vi.fn(),
    } as unknown as WorkflowController;

    render(
      <WorkflowSteps task={task} controller={controller} notify={vi.fn()} />,
    );

    const button = screen.getByRole("button", {
      name: "记录人工决策",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });
});
