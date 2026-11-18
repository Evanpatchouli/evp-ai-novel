import { useCallback, useEffect, useReducer, useState } from "react";
import { toast } from "@ldkj/web-ui";
import type {
  DecisionStatus,
  FinalConfirmation,
  ReviewIssue,
  TaskStage,
} from "../../../../shared/contracts";
import { api, type TaskDetail } from "../../api";
import type { ShowNotice } from "../../app/types";
import {
  createWorkflowState,
  DEFAULT_CONFIRMATION,
  STYLE_REFINEMENT_INSTRUCTION,
  workflowStateReducer,
} from "./workflowState";

export function useWorkflowController(
  task: TaskDetail | null,
  setTask: (task: TaskDetail | null) => void,
  notify: ShowNotice,
  onArchived?: (task: TaskDetail) => void | Promise<void>,
) {
  const [state, dispatch] = useReducer(
    workflowStateReducer,
    task,
    createWorkflowState,
  );
  const [baselineTask, setBaselineTask] = useState(task);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setBaselineTask(task);
    if ((task?.id ?? null) !== state.taskId) dispatch({ type: "reset", task });
  }, [state.taskId, task]);

  const act = async (
    name: string,
    operation: () => Promise<TaskDetail | void>,
  ) => {
    setBusy(name);
    setError("");
    try {
      const result = await operation();
      if (result) {
        // 同一任务的服务端基线更新不会触发 taskId effect；在这里显式重置，
        // 防止已保存表单继续注册 beforeunload 未保存保护。
        setBaselineTask(result);
        dispatch({ type: "reset", task: result });
        setTask(result);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败");
    } finally {
      setBusy("");
    }
  };

  const taskRequired = () => {
    if (!task) throw new Error("当前没有生产任务");
    return task;
  };

  const dirty = Boolean(
    baselineTask &&
    (JSON.stringify(
      state.context.map(({ path, selected }) => ({ path, selected })),
    ) !==
      JSON.stringify(
        (baselineTask.context ?? []).map(({ path, selected }) => ({
          path,
          selected,
        })),
      ) ||
      state.reviewText !== (baselineTask.reviewRaw ?? "") ||
      JSON.stringify(
        state.issues.map(({ id, decision, decisionNote }) => ({
          id,
          decision: decision ?? "later",
          decisionNote: decisionNote ?? "",
        })),
      ) !==
        JSON.stringify(
          (baselineTask.issues ?? []).map(({ id, decision, decisionNote }) => ({
            id,
            decision: decision ?? "later",
            decisionNote: decisionNote ?? "",
          })),
        ) ||
      JSON.stringify(state.revisionInstructionAdditions) !==
        JSON.stringify(
          baselineTask.prompt?.includes(STYLE_REFINEMENT_INSTRUCTION)
            ? [STYLE_REFINEMENT_INSTRUCTION]
            : [],
        ) ||
      state.revisionText !== (baselineTask.revisionRaw ?? "") ||
      JSON.stringify(state.confirmation) !==
        JSON.stringify(baselineTask.finalConfirmation ?? DEFAULT_CONFIRMATION)),
  );

  const updateIssue = useCallback(
    (index: number, patch: Partial<ReviewIssue>) =>
      dispatch({ type: "update-issue", index, patch }),
    [],
  );

  const notifyPackageGenerated = (
    zipPath: string,
    message: string,
    downloadLabel: string,
    downloadUrl: string,
  ) => {
    notify({
      tone: "success",
      message: `${message}：${zipPath}`,
      actions: [
        {
          kind: "link",
          label: downloadLabel,
          href: downloadUrl,
          download: true,
        },
        {
          kind: "button",
          label: "打开文件夹",
          onClick: () => {
            void api.open(zipPath, "folder").catch((cause) =>
              notify({
                tone: "error",
                message:
                  cause instanceof Error
                    ? cause.message
                    : "无法打开任务包所在文件夹",
              }),
            );
          },
        },
      ],
    });
  };

  return {
    state,
    dirty,
    busy,
    error,
    setPrompt: (prompt: string) =>
      dispatch({ type: "patch", patch: { prompt } }),
    setReviewText: (reviewText: string) =>
      dispatch({ type: "patch", patch: { reviewText } }),
    setRevisionText: (revisionText: string) =>
      dispatch({ type: "patch", patch: { revisionText } }),
    toggleContext: (index: number, selected: boolean) =>
      dispatch({ type: "toggle-context", index, selected }),
    updateIssue,
    setAllDecisions: (decision: DecisionStatus) =>
      dispatch({ type: "set-all-decisions", decision }),
    toggleRevisionInstruction: (checked: boolean) =>
      dispatch({
        type: "toggle-revision-instruction",
        instruction: STYLE_REFINEMENT_INSTRUCTION,
        checked,
      }),
    rewindStage: (stage: TaskStage) =>
      void act("rewind", async () => {
        const current = taskRequired();
        const result = await api.rewindTask(current.id, stage);
        notify({
          tone: "success",
          message: `任务已回退，可以从“${result.nextAction}”继续。`,
        });
        return result;
      }),
    confirm: (key: keyof FinalConfirmation, checked: boolean) =>
      dispatch({ type: "confirm", key, checked }),
    confirmAll: () => dispatch({ type: "confirm-all" }),
    loadContext: () =>
      void act("context", async () => {
        const current = taskRequired();
        const result = await api.context(current.id);
        dispatch({
          type: "patch",
          patch: { context: result.candidates, prompt: result.prompt ?? "" },
        });
      }),
    buildContext: () =>
      void act("build", async () => {
        const current = taskRequired();
        const result = await api.buildContext(
          current.id,
          state.context
            .filter((item) => item.selected)
            .map((item) => item.path),
        );
        dispatch({
          type: "patch",
          patch: {
            context: result.candidates,
            prompt: result.prompt ?? state.prompt,
          },
        });
        const packagePath = result.packagePath;
        notify({
          tone: "success",
          message: packagePath
            ? `任务包已生成：${packagePath}`
            : "上下文与提示词已生成。",
          actions: packagePath
            ? [
                {
                  kind: "link",
                  label: "下载任务包",
                  href: api.contextPackageDownloadUrl(current.id),
                  download: true,
                },
                {
                  kind: "button",
                  label: "打开文件夹",
                  onClick: () => {
                    void api.open(packagePath, "folder").catch((cause) =>
                      notify({
                        tone: "error",
                        message:
                          cause instanceof Error
                            ? cause.message
                            : "无法打开任务包所在文件夹",
                      }),
                    );
                  },
                },
              ]
            : undefined,
        });
        return api.task(current.id);
      }),
    importReview: () =>
      void act("review", async () => {
        const current = taskRequired();
        const result = await api.importReview(current.id, state.reviewText);
        dispatch({ type: "patch", patch: { issues: result.issues ?? [] } });
        toast.success("解析成功");
        return result;
      }),
    saveDecisions: () =>
      void act("decisions", async () => {
        const current = taskRequired();
        const result = await api.decisions(
          current.id,
          state.issues.map((issue) => ({
            id: issue.id,
            decision: issue.decision ?? "later",
            decisionNote: issue.decisionNote,
          })),
          state.revisionInstructionAdditions,
        );
        dispatch({
          type: "patch",
          patch: { prompt: result.prompt ?? state.prompt },
        });
        return result;
      }),
    buildRevisionPackage: () =>
      void act("revision-package", async () => {
        const current = taskRequired();
        const result = await api.buildRevisionPackage(current.id);
        notifyPackageGenerated(
          result.zipPath,
          "完整审计包已生成",
          "下载完整审计包",
          api.revisionPackageDownloadUrl(current.id),
        );
      }),
    buildCompactRevisionPackage: () =>
      void act("compact-revision-package", async () => {
        const current = taskRequired();
        const result = await api.buildCompactRevisionPackage(current.id);
        notifyPackageGenerated(
          result.zipPath,
          "精简修订包已生成",
          "下载精简修订包",
          api.compactRevisionPackageDownloadUrl(current.id),
        );
      }),
    buildCompactTextRevisionPackage: () =>
      void act("compact-text-revision-package", async () => {
        const current = taskRequired();
        const result = await api.buildCompactTextRevisionPackage(current.id);
        notifyPackageGenerated(
          result.textPath,
          "单文件修订包已生成",
          "下载单文件包",
          api.compactTextRevisionPackageDownloadUrl(current.id),
        );
      }),
    importRevision: () =>
      void act("revision", () =>
        api.importRevision(taskRequired().id, state.revisionText),
      ),
    saveHumanFinal: () =>
      void act("human-final", () =>
        api.saveHumanFinal(taskRequired().id, state.revisionText),
      ),
    confirmFinal: () =>
      void act("confirmation", () =>
        api.confirmFinal(taskRequired().id, state.confirmation),
      ),
    makePreview: () =>
      void act("preview", async () => {
        const preview = await api.writePreview(taskRequired().id);
        dispatch({ type: "patch", patch: { preview } });
      }),
    write: () =>
      void act("write", async () => {
        if (!state.preview) return;
        const result = await api.commitWrite(
          taskRequired().id,
          state.preview.token,
        );
        dispatch({ type: "patch", patch: { preview: null } });
        notify({ tone: "success", message: "正文与状态表已完成原子写入。" });
        return result;
      }),
    archive: () =>
      void act("archive", async () => {
        const archived = await api.archiveTask(taskRequired().id);
        await onArchived?.(archived);
      }),
  };
}

export type WorkflowController = ReturnType<typeof useWorkflowController>;
