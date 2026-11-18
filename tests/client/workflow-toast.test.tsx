/** @vitest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDetail } from "../../client/src/api.js";
import { useWorkflowController } from "../../client/src/features/workflow/useWorkflowController.js";

const {
  archiveTaskMock,
  buildCompactRevisionPackageMock,
  buildCompactTextRevisionPackageMock,
  buildRevisionPackageMock,
  confirmFinalMock,
  decisionsMock,
  importReviewMock,
  saveHumanFinalMock,
  openMock,
  toastSuccessMock,
} = vi.hoisted(() => ({
  archiveTaskMock: vi.fn(),
  buildCompactRevisionPackageMock: vi.fn(),
  buildCompactTextRevisionPackageMock: vi.fn(),
  buildRevisionPackageMock: vi.fn(),
  confirmFinalMock: vi.fn(),
  decisionsMock: vi.fn(),
  importReviewMock: vi.fn(),
  saveHumanFinalMock: vi.fn(),
  openMock: vi.fn(),
  toastSuccessMock: vi.fn(),
}));

vi.mock("../../client/src/api.js", () => ({
  api: {
    archiveTask: archiveTaskMock,
    buildCompactRevisionPackage: buildCompactRevisionPackageMock,
    buildCompactTextRevisionPackage: buildCompactTextRevisionPackageMock,
    buildRevisionPackage: buildRevisionPackageMock,
    confirmFinal: confirmFinalMock,
    decisions: decisionsMock,
    importReview: importReviewMock,
    saveHumanFinal: saveHumanFinalMock,
    open: openMock,
    revisionPackageDownloadUrl: (id: string) =>
      `/api/tasks/${id}/revision-package/download`,
    compactRevisionPackageDownloadUrl: (id: string) =>
      `/api/tasks/${id}/revision-package/compact/download`,
    compactTextRevisionPackageDownloadUrl: (id: string) =>
      `/api/tasks/${id}/revision-package/compact-text/download`,
  },
}));

vi.mock("@ldkj/web-ui", () => ({
  toast: { success: toastSuccessMock },
}));

const task = {
  id: "task-1",
  stage: "context-ready",
} as TaskDetail;

beforeEach(() => {
  archiveTaskMock.mockReset();
  buildCompactRevisionPackageMock.mockReset();
  buildCompactTextRevisionPackageMock.mockReset();
  buildRevisionPackageMock.mockReset();
  confirmFinalMock.mockReset();
  decisionsMock.mockReset();
  importReviewMock.mockReset();
  saveHumanFinalMock.mockReset();
  openMock.mockReset();
  toastSuccessMock.mockReset();
});

describe("审稿报告解析 Toast", () => {
  it("解析成功后调用组件库静态成功 Toast", async () => {
    const parsedTask = {
      ...task,
      stage: "review-imported",
      issues: [],
    } as TaskDetail;
    importReviewMock.mockResolvedValue(parsedTask);
    const setTask = vi.fn();
    const { result } = renderHook(() =>
      useWorkflowController(task, setTask, vi.fn()),
    );

    act(() => result.current.setReviewText("## 审稿结论"));
    act(() => result.current.importReview());

    await waitFor(() =>
      expect(importReviewMock).toHaveBeenCalledWith("task-1", "## 审稿结论"),
    );
    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledTimes(1));
    expect(toastSuccessMock).toHaveBeenCalledWith("解析成功");
    expect(setTask).toHaveBeenCalledWith(parsedTask);
  });

  it("解析失败时不调用成功 Toast", async () => {
    importReviewMock.mockRejectedValue(new Error("解析失败"));
    const { result } = renderHook(() =>
      useWorkflowController(task, vi.fn(), vi.fn()),
    );

    act(() => result.current.importReview());

    await waitFor(() => expect(result.current.error).toBe("解析失败"));
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  it("未保存审稿保持 dirty，失败后保留，保存成功后立即清理", async () => {
    const parsedTask = {
      ...task,
      stage: "review-imported",
      reviewRaw: "## 待保存审稿",
      issues: [],
    } as TaskDetail;
    importReviewMock.mockRejectedValueOnce(new Error("保存失败"));
    const { result } = renderHook(
      ({ currentTask }: { currentTask: TaskDetail }) =>
        useWorkflowController(currentTask, vi.fn(), vi.fn()),
      { initialProps: { currentTask: task } },
    );

    expect(result.current.dirty).toBe(false);
    act(() => result.current.setReviewText("## 待保存审稿"));
    expect(result.current.dirty).toBe(true);

    act(() => result.current.importReview());
    await waitFor(() => expect(result.current.error).toBe("保存失败"));
    expect(result.current.dirty).toBe(true);

    importReviewMock.mockResolvedValueOnce(parsedTask);
    act(() => result.current.importReview());
    await waitFor(() => expect(importReviewMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.dirty).toBe(false));
  });

  it("归档成功交给完成态承接且不把 archived 写回活动任务", async () => {
    const written = { ...task, stage: "written" } as TaskDetail;
    const archived = { ...written, stage: "archived" } as TaskDetail;
    archiveTaskMock.mockResolvedValue(archived);
    const setTask = vi.fn();
    const onArchived = vi.fn();
    const { result } = renderHook(() =>
      useWorkflowController(written, setTask, vi.fn(), onArchived),
    );

    act(() => result.current.archive());

    await waitFor(() => expect(onArchived).toHaveBeenCalledWith(archived));
    expect(setTask).not.toHaveBeenCalled();
  });

  it("归档操作在异步完成态回调结束前保持忙碌", async () => {
    const written = { ...task, stage: "written" } as TaskDetail;
    const archived = { ...written, stage: "archived" } as TaskDetail;
    archiveTaskMock.mockResolvedValue(archived);
    let finishCompletion!: () => void;
    const onArchived = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCompletion = resolve;
        }),
    );
    const { result } = renderHook(() =>
      useWorkflowController(written, vi.fn(), vi.fn(), onArchived),
    );

    act(() => result.current.archive());
    await waitFor(() => expect(onArchived).toHaveBeenCalledWith(archived));
    expect(result.current.busy).toBe("archive");

    finishCompletion();
    await waitFor(() => expect(result.current.busy).toBe(""));
  });

  it("人工终审稿与五项确认通过两个独立阶段提交", async () => {
    const revisionImported = {
      ...task,
      stage: "revision-imported",
      revisionRaw: "# 人工终审稿",
    } as TaskDetail;
    const humanFinal = {
      ...revisionImported,
      stage: "human-final-review",
    } as TaskDetail;
    const readyToWrite = {
      ...humanFinal,
      stage: "ready-to-write",
    } as TaskDetail;
    saveHumanFinalMock.mockResolvedValue(humanFinal);
    confirmFinalMock.mockResolvedValue(readyToWrite);
    const setTask = vi.fn();
    const { result, rerender } = renderHook(
      ({ currentTask }: { currentTask: TaskDetail }) =>
        useWorkflowController(currentTask, setTask, vi.fn()),
      { initialProps: { currentTask: revisionImported } },
    );

    act(() => result.current.saveHumanFinal());
    await waitFor(() =>
      expect(saveHumanFinalMock).toHaveBeenCalledWith("task-1", "# 人工终审稿"),
    );
    expect(confirmFinalMock).not.toHaveBeenCalled();

    rerender({ currentTask: humanFinal });
    act(() => result.current.confirmFinal());
    await waitFor(() =>
      expect(confirmFinalMock).toHaveBeenCalledWith(
        "task-1",
        result.current.state.confirmation,
      ),
    );
    expect(setTask).toHaveBeenCalledWith(readyToWrite);
  });

  it("完成人工决策后切换为修订提示词", async () => {
    const reviewImported = {
      ...task,
      stage: "review-imported",
      prompt: "审查提示词",
      issues: [
        {
          id: "issue-001",
          severity: "important",
          title: "人物动机不清",
          detail: "缺少动机证据",
          decision: "approved",
        },
      ],
    } as TaskDetail;
    const decisionsRecorded = {
      ...reviewImported,
      stage: "decisions-recorded",
      prompt: "请按批准项修订正文",
    } as TaskDetail;
    decisionsMock.mockResolvedValue(decisionsRecorded);
    const { result } = renderHook(() =>
      useWorkflowController(reviewImported, vi.fn(), vi.fn()),
    );

    act(() => result.current.saveDecisions());

    await waitFor(() => expect(decisionsMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(result.current.state.prompt).toBe("请按批准项修订正文"),
    );
  });

  it("生成完整审计包后提供下载和打开文件夹操作", async () => {
    const decisionsRecorded = {
      ...task,
      stage: "decisions-recorded",
    } as TaskDetail;
    const zipPath = "30_生产/active/task-1/04_AI修订上下文.zip";
    buildRevisionPackageMock.mockResolvedValue({ zipPath });
    openMock.mockResolvedValue(undefined);
    const notify = vi.fn();
    const { result } = renderHook(() =>
      useWorkflowController(decisionsRecorded, vi.fn(), notify),
    );

    act(() => result.current.buildRevisionPackage());

    await waitFor(() =>
      expect(buildRevisionPackageMock).toHaveBeenCalledWith("task-1"),
    );
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    const notice = notify.mock.calls[0][0];
    expect(notice).toMatchObject({
      tone: "success",
      message: `完整审计包已生成：${zipPath}`,
      actions: [
        {
          kind: "link",
          label: "下载完整审计包",
          href: "/api/tasks/task-1/revision-package/download",
          download: true,
        },
        { kind: "button", label: "打开文件夹" },
      ],
    });
    const openAction = notice.actions?.[1];
    if (openAction?.kind !== "button") throw new Error("缺少打开文件夹操作");
    act(() => openAction.onClick());
    await waitFor(() =>
      expect(openMock).toHaveBeenCalledWith(zipPath, "folder"),
    );
  });

  it("生成精简修订包后使用独立下载地址", async () => {
    const decisionsRecorded = {
      ...task,
      stage: "decisions-recorded",
    } as TaskDetail;
    const zipPath = "30_生产/active/task-1/04_AI修订精简包.zip";
    buildCompactRevisionPackageMock.mockResolvedValue({ zipPath });
    const notify = vi.fn();
    const { result } = renderHook(() =>
      useWorkflowController(decisionsRecorded, vi.fn(), notify),
    );

    act(() => result.current.buildCompactRevisionPackage());

    await waitFor(() =>
      expect(buildCompactRevisionPackageMock).toHaveBeenCalledWith("task-1"),
    );
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify.mock.calls[0][0]).toMatchObject({
      tone: "success",
      message: `精简修订包已生成：${zipPath}`,
      actions: [
        {
          kind: "link",
          label: "下载精简修订包",
          href: "/api/tasks/task-1/revision-package/compact/download",
          download: true,
        },
        { kind: "button", label: "打开文件夹" },
      ],
    });
  });

  it("生成 DeepSeek 单文件包后使用 TXT 下载地址", async () => {
    const decisionsRecorded = {
      ...task,
      stage: "decisions-recorded",
    } as TaskDetail;
    const textPath = "30_生产/active/task-1/04_AI修订精简单文件.txt";
    buildCompactTextRevisionPackageMock.mockResolvedValue({ textPath });
    const notify = vi.fn();
    const { result } = renderHook(() =>
      useWorkflowController(decisionsRecorded, vi.fn(), notify),
    );

    act(() => result.current.buildCompactTextRevisionPackage());

    await waitFor(() =>
      expect(buildCompactTextRevisionPackageMock).toHaveBeenCalledWith(
        "task-1",
      ),
    );
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify.mock.calls[0][0]).toMatchObject({
      tone: "success",
      message: `单文件修订包已生成：${textPath}`,
      actions: [
        {
          kind: "link",
          label: "下载单文件包",
          href: "/api/tasks/task-1/revision-package/compact-text/download",
          download: true,
        },
        { kind: "button", label: "打开文件夹" },
      ],
    });
  });
});
