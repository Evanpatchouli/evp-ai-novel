import { useEffect, useRef, useState } from "react";
import { Button } from "@ldkj/web-ui";
import { Link, useNavigate, useParams } from "react-router";
import { chapterHref } from "../../../../shared/reader-paths";
import { api } from "../../api";
import { useRepositorySession } from "../../app/RepositorySession";
import { useUnsavedChangesGuard } from "../../app/UnsavedChangesContext";
import { PageHeader, Panel } from "../../components/layout";
import { EmptyState, ErrorState, LoadingState } from "../../components/states";
import { StageRail } from "./StageRail";
import { DecisionCountChip } from "./DecisionCountChip";
import { useWorkflowController } from "./useWorkflowController";
import { WorkflowSteps } from "./WorkflowSteps";

export function WorkflowPage() {
  const {
    task,
    setTask,
    clearTask,
    loadDashboard,
    refreshDashboard,
    showNotice,
  } = useRepositorySession();
  const { taskId } = useParams();
  const navigate = useNavigate();
  const [routeBusy, setRouteBusy] = useState(false);
  const [routeError, setRouteError] = useState("");
  const [archivedTask, setArchivedTask] = useState<typeof task>(null);
  const [archiveSyncingTaskId, setArchiveSyncingTaskId] = useState("");
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const controller = useWorkflowController(
    task,
    setTask,
    showNotice,
    async (completed) => {
      setArchiveSyncingTaskId(completed.id);
      clearTask(completed.id);
      try {
        await refreshDashboard();
      } catch (cause) {
        showNotice({
          tone: "error",
          message: `任务已归档，但章节列表刷新失败：${
            cause instanceof Error ? cause.message : "未知错误"
          }`,
          actions: [
            {
              kind: "button",
              label: "重新读取",
              onClick: () => void loadDashboard(),
            },
          ],
        });
      }
      if (mountedRef.current) {
        setArchivedTask(completed);
        setArchiveSyncingTaskId("");
      }
    },
  );
  useUnsavedChangesGuard(controller.dirty);

  useEffect(() => {
    if (!taskId) {
      if (task)
        navigate(`/workflow/${encodeURIComponent(task.id)}`, { replace: true });
      return;
    }
    if (archiveSyncingTaskId === taskId) return;
    if (archivedTask?.id === taskId) return;
    if (task?.id === taskId && task.stage === "archived") {
      setArchivedTask(task);
      setTask(null);
      return;
    }
    if (task?.id === taskId) return;
    let cancelled = false;
    setRouteBusy(true);
    setRouteError("");
    void api
      .task(taskId)
      .then((loaded) => {
        if (!cancelled) {
          if (loaded.stage === "archived") {
            setArchivedTask(loaded);
            setTask(null);
          } else {
            setArchivedTask(null);
            setTask(loaded);
          }
        }
      })
      .catch((cause) => {
        if (!cancelled)
          setRouteError(
            cause instanceof Error ? cause.message : "无法读取生产任务",
          );
      })
      .finally(() => {
        if (!cancelled) setRouteBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [archiveSyncingTaskId, archivedTask, navigate, setTask, task, taskId]);

  const completed =
    archivedTask?.id === taskId
      ? archivedTask
      : task && task.id === taskId && task.stage === "archived"
        ? task
        : null;
  if (completed) {
    return (
      <>
        <PageHeader
          eyebrow={`${completed.volumeId} · ${completed.chapterId}`}
          title="本轮终稿验收已完成"
          description="生产工件已经归档，可返回章节查看终稿，或继续选择下一章。"
        />
        <Panel>
          <div className="inline-actions">
            <Button
              className="button-link"
              component={Link}
              to={chapterHref(completed.volumeId, completed.chapterId)}
              variant="outline"
            >
              返回本章
            </Button>
            <Button
              className="button-link"
              component={Link}
              to="/chapters"
              variant="outline"
            >
              选择下一章
            </Button>
          </div>
        </Panel>
      </>
    );
  }
  if (routeError)
    return (
      <>
        <PageHeader
          eyebrow="终稿验收"
          title="无法打开任务"
          description="当前地址中的任务不属于所选仓库。"
        />
        <ErrorState message={routeError} />
      </>
    );
  const routeMismatch = Boolean(taskId && task?.id !== taskId);
  if (routeBusy || routeMismatch)
    return <LoadingState label="正在读取生产任务" />;
  if (!task)
    return (
      <>
        <PageHeader
          eyebrow="终稿验收"
          title="先选择一章"
          description="九阶段向导需要一个独立生产任务作为安全边界。"
        />
        <Panel>
          <EmptyState label="没有进行中的任务" detail="请在章节页创建任务。" />
        </Panel>
      </>
    );

  return (
    <div className="workflow-page" data-testid={`workflow-stage-${task.stage}`}>
      <div className="workflow-page-header">
        <PageHeader
          eyebrow={`${task.volumeId} · ${task.chapterId}`}
          title={task.chapter?.title ?? "单章终稿验收"}
          description={task.nextAction}
          actions={<DecisionCountChip count={task.pendingDecisionCount} />}
        />
      </div>
      {controller.error && (
        <div className="workflow-error">
          <ErrorState message={controller.error} />
        </div>
      )}
      <div className="workflow-layout">
        <StageRail
          stage={task.stage}
          busy={controller.busy === "rewind"}
          onRewind={controller.rewindStage}
        />
        <WorkflowSteps
          task={task}
          controller={controller}
          notify={showNotice}
        />
      </div>
    </div>
  );
}
