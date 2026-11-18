/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskDetail } from "../../client/src/api.js";

const mocks = vi.hoisted(() => ({
  apiTask: vi.fn(),
  setTask: vi.fn(),
  clearTask: vi.fn(),
  loadDashboard: vi.fn(),
  refreshDashboard: vi.fn(),
  showNotice: vi.fn(),
  workflowSteps: vi.fn(),
  unsavedGuard: vi.fn(),
  onArchived: undefined as
    ((task: TaskDetail) => void | Promise<void>) | undefined,
}));

vi.mock("../../client/src/api.js", () => ({
  api: { task: mocks.apiTask },
}));

vi.mock("../../client/src/app/RepositorySession.js", () => ({
  useRepositorySession: () => ({
    task: {
      id: "task-a",
      volumeId: "v01",
      chapterId: "ch001",
      stage: "created",
      nextAction: "准备任务 A",
      pendingDecisionCount: 0,
    } as TaskDetail,
    setTask: mocks.setTask,
    clearTask: mocks.clearTask,
    loadDashboard: mocks.loadDashboard,
    refreshDashboard: mocks.refreshDashboard,
    showNotice: mocks.showNotice,
  }),
}));

vi.mock("../../client/src/app/UnsavedChangesContext.js", () => ({
  useUnsavedChangesGuard: mocks.unsavedGuard,
}));

vi.mock("../../client/src/features/workflow/useWorkflowController.js", () => ({
  useWorkflowController: (
    _task: TaskDetail | null,
    _setTask: unknown,
    _showNotice: unknown,
    onArchived?: (task: TaskDetail) => void | Promise<void>,
  ) => {
    mocks.onArchived = onArchived;
    return {
      error: "",
      busy: "",
      dirty: true,
      state: {},
    };
  },
}));

vi.mock("../../client/src/features/workflow/WorkflowSteps.js", () => ({
  WorkflowSteps: ({ task }: { task: TaskDetail }) => {
    mocks.workflowSteps(task.id);
    return <button type="button">执行 {task.id} 的操作</button>;
  },
}));

import { WorkflowPage } from "../../client/src/features/workflow/WorkflowPage.js";

afterEach(() => {
  cleanup();
  Object.values(mocks).forEach((mock) => {
    if (typeof mock === "function" && "mockReset" in mock) mock.mockReset();
  });
  mocks.onArchived = undefined;
});

describe("WorkflowPage 路由任务隔离", () => {
  it("任务 B 尚未读取完成时绝不渲染任务 A 的可操作表单", () => {
    mocks.apiTask.mockReturnValue(new Promise(() => undefined));
    const router = createMemoryRouter(
      [{ path: "/workflow/:taskId", element: <WorkflowPage /> }],
      { initialEntries: ["/workflow/task-b"] },
    );

    render(<RouterProvider router={router} />);

    expect(mocks.workflowSteps).not.toHaveBeenCalledWith("task-a");
    expect(mocks.unsavedGuard).toHaveBeenCalledWith(true);
  });

  it("归档后等待 dashboard 静默刷新，再进入可离开的完成态", async () => {
    let finishRefresh!: () => void;
    mocks.refreshDashboard.mockReturnValue(
      new Promise<void>((resolve) => {
        finishRefresh = resolve;
      }),
    );
    const router = createMemoryRouter(
      [{ path: "/workflow/:taskId", element: <WorkflowPage /> }],
      { initialEntries: ["/workflow/task-a"] },
    );
    render(<RouterProvider router={router} />);

    const archived = {
      id: "task-a",
      volumeId: "v01",
      chapterId: "ch001",
      stage: "archived",
    } as TaskDetail;
    let completion!: Promise<void>;
    act(() => {
      completion = Promise.resolve(mocks.onArchived?.(archived));
    });

    expect(mocks.refreshDashboard).toHaveBeenCalledOnce();
    expect(mocks.clearTask).toHaveBeenCalledWith("task-a");
    expect(screen.queryByText("本轮终稿验收已完成")).toBeNull();

    finishRefresh();
    await act(async () => completion);

    expect(screen.getByText("本轮终稿验收已完成")).not.toBeNull();
  });

  it("归档后的刷新失败不会回退成可重复归档状态", async () => {
    mocks.refreshDashboard.mockRejectedValue(new Error("读取超时"));
    const router = createMemoryRouter(
      [{ path: "/workflow/:taskId", element: <WorkflowPage /> }],
      { initialEntries: ["/workflow/task-a"] },
    );
    render(<RouterProvider router={router} />);
    const archived = {
      id: "task-a",
      volumeId: "v01",
      chapterId: "ch001",
      stage: "archived",
    } as TaskDetail;

    await act(async () => {
      await mocks.onArchived?.(archived);
    });

    expect(mocks.clearTask).toHaveBeenCalledWith("task-a");
    expect(screen.getByText("本轮终稿验收已完成")).not.toBeNull();
    expect(mocks.showNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        tone: "error",
        message: expect.stringContaining("任务已归档，但章节列表刷新失败"),
      }),
    );
  });
});
