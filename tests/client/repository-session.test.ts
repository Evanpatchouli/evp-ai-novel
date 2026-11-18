import { describe, expect, it } from "vitest";
import type { DashboardData } from "../../shared/contracts.js";
import type { TaskDetail } from "../../client/src/api.js";
import {
  initialRepositorySession,
  repositorySessionReducer,
} from "../../client/src/app/RepositorySession.js";

const dashboard = (
  root: string,
  currentTask?: DashboardData["currentTask"],
): DashboardData => ({
  repositoryRoot: root,
  projectName: root,
  volumes: [],
  currentTask,
  health: { healthy: true, issues: [] },
  git: {
    available: true,
    branch: "main",
    clean: true,
    changes: [],
    ahead: 0,
    behind: 0,
    plainLanguage: [],
    suggestedCommands: [],
    suggestedCommitMessage: "",
  },
  continuity: {
    characterFiles: 0,
    activeForeshadowFiles: 0,
    timelineFiles: 0,
    unresolvedReviewItems: 0,
  },
});

describe("repositorySessionReducer", () => {
  it("静默刷新只替换 dashboard，不进入全页加载或改写当前任务", () => {
    const currentTask = { id: "task-1" } as TaskDetail;
    const oldState = {
      ...initialRepositorySession,
      dashboard: dashboard("root", currentTask),
      task: currentTask,
      repositoryPath: "root",
      loading: false,
    };
    const refreshed = dashboard("root");
    const next = repositorySessionReducer(oldState, {
      type: "dashboard-refreshed",
      dashboard: refreshed,
    });

    expect(next.dashboard).toBe(refreshed);
    expect(next.task).toBe(currentTask);
    expect(next.loading).toBe(false);
    expect(next.repositoryPath).toBe("root");
  });

  it("只清理匹配的已归档任务，不覆盖等待期间出现的新任务", () => {
    const newTask = { id: "task-b" } as TaskDetail;
    const state = {
      ...initialRepositorySession,
      dashboard: dashboard("root", newTask),
      task: newTask,
    };

    expect(
      repositorySessionReducer(state, {
        type: "clear-task",
        taskId: "task-a",
      }).task,
    ).toBe(newTask);
    expect(
      repositorySessionReducer(state, {
        type: "clear-task",
        taskId: "task-b",
      }).task,
    ).toBeNull();
  });

  it("新仓库没有任务时显式清空旧任务", () => {
    const oldTask = { id: "old-task" } as TaskDetail;
    const oldState = {
      ...initialRepositorySession,
      dashboard: dashboard("old", oldTask),
      task: oldTask,
      repositoryPath: "old",
    };
    const next = repositorySessionReducer(oldState, {
      type: "loaded",
      dashboard: dashboard("new"),
      task: null,
    });

    expect(next.dashboard?.repositoryRoot).toBe("new");
    expect(next.task).toBeNull();
    expect(next.repositoryPath).toBe("new");
  });

  it("开始切仓时使旧会话失效", () => {
    const oldTask = { id: "old-task" } as TaskDetail;
    const oldState = {
      ...initialRepositorySession,
      dashboard: dashboard("old", oldTask),
      task: oldTask,
    };
    const next = repositorySessionReducer(oldState, {
      type: "switching",
      repositoryPath: "new",
    });

    expect(next.dashboard).toBeNull();
    expect(next.task).toBeNull();
    expect(next.loading).toBe(true);
  });
});
