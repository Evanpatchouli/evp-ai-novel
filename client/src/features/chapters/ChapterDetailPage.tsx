import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Icon } from "@ldkj/web-ui";
import { Link, useNavigate, useParams } from "react-router";
import type {
  ChapterDetail,
  ChapterMutationPreview,
  ProductionTaskSummary,
} from "../../../../shared/contracts";
import { volumeHref } from "../../../../shared/reader-paths";
import { ApiRequestError, api } from "../../api";
import {
  usePageQuickActions,
  type PageQuickAction,
} from "../../app/PageQuickActionsContext";
import { useRepositorySession } from "../../app/RepositorySession";
import { useUnsavedChangesGuard } from "../../app/UnsavedChangesContext";
import { AsyncButton } from "../../components/AsyncButton";
import { BreadcrumbTrail } from "../../components/BreadcrumbTrail";
import { PageHeader, Panel } from "../../components/layout";
import { MarkdownContent } from "../../components/MarkdownContent";
import { MutationPreviewDialog } from "../../components/MutationPreviewDialog";
import { ErrorState, LoadingState } from "../../components/states";
import { StatusChip } from "./ChapterRow";
import { ChapterEditor } from "./ChapterEditor";
import { chapterDetailHref, stripLeadingChapterH1 } from "./chapterNavigation";

function formatModifiedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "long",
    timeStyle: "short",
  }).format(date);
}

function removeBlankLines(content: string): string {
  return content
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .join("\n");
}

function ReaderNavigation({
  chapter,
  position,
}: {
  chapter: ChapterDetail;
  position: "上方" | "下方";
}) {
  return (
    <nav
      className="reader-navigation"
      aria-label={`章节阅读导航（${position}）`}
    >
      {chapter.previous ? (
        <Link rel="prev" to={chapterDetailHref(chapter.previous)}>
          <span>上一章</span>
          <strong>{chapter.previous.title}</strong>
        </Link>
      ) : (
        <span aria-disabled="true">已经是全书第一章</span>
      )}
      <Link
        className="return-volume"
        to={volumeHref(chapter.volume.id)}
      >
        返回《{chapter.volume.title}》
      </Link>
      {chapter.next ? (
        <Link rel="next" to={chapterDetailHref(chapter.next)}>
          <span>下一章</span>
          <strong>{chapter.next.title}</strong>
        </Link>
      ) : (
        <span aria-disabled="true">已经是全书最后一章</span>
      )}
    </nav>
  );
}

export function ChapterDetailPage() {
  const { volumeId = "", chapterId = "" } = useParams();
  const navigate = useNavigate();
  const { setTask, showNotice } = useRepositorySession();
  const [chapter, setChapter] = useState<ChapterDetail | null>(null);
  const [activeTask, setActiveTask] = useState<ProductionTaskSummary | null>(
    null,
  );
  const [busy, setBusy] = useState(true);
  const [taskBusy, setTaskBusy] = useState(false);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [preview, setPreview] = useState<ChapterMutationPreview | null>(null);
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [exitHref, setExitHref] = useState("");
  const [draft, setDraft] = useState("");
  const [conflict, setConflict] = useState(false);
  const [archiveReason, setArchiveReason] = useState("");
  const [confirmFinalArchive, setConfirmFinalArchive] = useState(false);
  const [error, setError] = useState("");
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useUnsavedChangesGuard(dirty && !exitHref);
  useEffect(() => {
    if (exitHref) void navigate(exitHref, { replace: true });
  }, [exitHref, navigate]);

  useEffect(() => {
    let cancelled = false;
    setChapter(null);
    setEditing(false);
    setDirty(false);
    setDraft("");
    setBusy(true);
    setError("");
    void Promise.all([api.chapter(volumeId, chapterId), api.tasks()])
      .then(([loaded, tasks]) => {
        if (!cancelled) {
          setChapter(loaded);
          setDraft(loaded.content);
          draftRef.current = loaded.content;
          setActiveTask(
            tasks.find(
              (task) =>
                task.volumeId === loaded.volumeId &&
                task.chapterId === loaded.chapterId &&
                task.stage !== "archived",
            ) ?? null,
          );
        }
      })
      .catch((cause) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : "无法读取章节");
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [chapterId, volumeId]);

  const createRevisionTask = async () => {
    if (!chapter) return;
    setTaskBusy(true);
    try {
      const task = await api.createTask(
        chapter.volumeId,
        chapter.chapterId,
        chapter.status === "final",
      );
      setTask(task);
      showNotice({
        tone: "success",
        message:
          chapter.status === "final"
            ? "已为终稿显式创建新一轮修订任务，原正文尚未修改。"
            : "生产任务已创建，正式正文尚未修改。",
      });
      navigate(`/workflow/${encodeURIComponent(task.id)}`);
    } catch (cause) {
      showNotice({
        tone: "error",
        message: cause instanceof Error ? cause.message : "创建任务失败",
      });
    } finally {
      setTaskBusy(false);
    }
  };

  const continueTask = () => {
    if (!activeTask) return;
    navigate(`/workflow/${encodeURIComponent(activeTask.id)}`);
  };

  const previewEdit = useCallback(
    async (content: string) => {
      if (!chapter) return;
      setMutationBusy(true);
      setError("");
      setConflict(false);
      try {
        setPreview(
          await api.previewChapterEdit(
            chapter.volumeId,
            chapter.chapterId,
            content,
            chapter.sourceHash,
          ),
        );
      } catch (cause) {
        setConflict(
          cause instanceof ApiRequestError &&
            ["SOURCE_CHANGED", "MUTATION_CONFLICT"].includes(cause.code),
        );
        setError(cause instanceof Error ? cause.message : "无法生成保存预览");
      } finally {
        setMutationBusy(false);
      }
    },
    [chapter],
  );

  const quickSave = useCallback(() => {
    void previewEdit(draftRef.current);
  }, [previewEdit]);

  const copySourceMarkdown = useCallback(async () => {
    if (!chapter) return;
    try {
      await navigator.clipboard.writeText(removeBlankLines(chapter.content));
      showNotice({
        tone: "success",
        message: "章节源 Markdown（已去除空行）已复制到剪贴板。",
      });
    } catch {
      showNotice({
        tone: "error",
        message: "浏览器拒绝访问剪贴板，请手动复制章节源 Markdown。",
      });
    }
  }, [chapter, showNotice]);

  const pageQuickActions = useMemo<PageQuickAction[]>(() => {
    if (!chapter) return [];
    if (editing) {
      return [
        {
          itemKey: "chapter-edit-mode",
          label: "预览章节",
          icon: <Icon name="visibility" size={19} />,
          onClick: () => setEditing(false),
        },
        {
          itemKey: "chapter-quick-save",
          label: "快捷保存",
          icon: <Icon name="save" size={19} />,
          disabled: !dirty || mutationBusy,
          onClick: quickSave,
        },
      ];
    }
    const copyAction: PageQuickAction = {
      itemKey: "chapter-copy-source-markdown",
      label: "复制源 Markdown",
      icon: <Icon name="content_copy" size={19} />,
      onClick: () => void copySourceMarkdown(),
    };
    if (chapter.status === "final") return [copyAction];
    const toggleAction: PageQuickAction = {
      itemKey: "chapter-edit-mode",
      label: "编辑章节",
      icon: <Icon name="edit" size={19} />,
      onClick: () => setEditing((current) => !current),
    };
    return [copyAction, toggleAction];
  }, [chapter, copySourceMarkdown, dirty, editing, mutationBusy, quickSave]);
  usePageQuickActions(pageQuickActions);

  const previewArchive = async () => {
    if (!chapter) return;
    setMutationBusy(true);
    setError("");
    try {
      setPreview(
        await api.previewChapterArchive(
          chapter.volumeId,
          chapter.chapterId,
          archiveReason,
          chapter.sourceHash,
          confirmFinalArchive,
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法生成归档预览");
    } finally {
      setMutationBusy(false);
    }
  };

  const commitMutation = async () => {
    if (!preview) return;
    setMutationBusy(true);
    setError("");
    try {
      const result = await api.commitChapterMutation(
        preview.token,
        preview.confirmationRequirements,
      );
      setPreview(null);
      if (result.kind === "archive" || result.kind === "delete") {
        setExitHref(result.destinationHref);
      } else if (result.chapter) {
        setChapter(result.chapter);
        setDraft(result.chapter.content);
        setDirty(false);
        showNotice({ tone: "success", message: "章节 Markdown 已安全写入。" });
      }
    } catch (cause) {
      setConflict(
        cause instanceof ApiRequestError && cause.code === "MUTATION_CONFLICT",
      );
      setError(cause instanceof Error ? cause.message : "章节操作失败");
      setPreview(null);
    } finally {
      setMutationBusy(false);
    }
  };

  const previewDelete = async () => {
    if (!chapter) return;
    setMutationBusy(true);
    setError("");
    try {
      setPreview(await api.previewChapterDelete(chapter.volumeId, chapter.chapterId, chapter.sourceHash));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法生成删除预览");
    } finally {
      setMutationBusy(false);
    }
  };

  const copyDraft = async () => {
    await navigator.clipboard.writeText(draft);
    showNotice({ tone: "success", message: "当前草稿已复制到剪贴板。" });
  };

  const reloadChapter = async () => {
    if (!chapter) return;
    setMutationBusy(true);
    try {
      const loaded = await api.chapter(chapter.volumeId, chapter.chapterId);
      setChapter(loaded);
      setDraft(loaded.content);
      setDirty(false);
      setConflict(false);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "重新读取章节失败");
    } finally {
      setMutationBusy(false);
    }
  };

  if (busy) return <LoadingState label="正在读取章节正文" />;
  if (!chapter)
    return (
      <>
        <PageHeader
          eyebrow={`${volumeId || "卷"} · ${chapterId || "章节"}`}
          title="无法打开这一章"
          description="当前地址中的章节不属于所选仓库。"
        />
        <ErrorState message={error || "章节不存在"} />
      </>
    );

  const readerContent = stripLeadingChapterH1(dirty ? draft : chapter.content);
  return (
    <article className="chapter-reader">
      <BreadcrumbTrail
        items={[
          { label: "章节总览", to: "/chapters" },
          {
            label: `第 ${chapter.volume.number} 卷 · ${chapter.volume.title}`,
            to: volumeHref(chapter.volume.id),
          },
          { label: chapter.title },
        ]}
      />
      <PageHeader
        eyebrow={`第 ${chapter.volume.number} 卷 · 第 ${String(chapter.number).padStart(3, "0")} 章`}
        title={chapter.title}
        description={`${chapter.volume.title} · ${chapter.wordCount.toLocaleString()} 字 · 最后修改于 ${formatModifiedAt(chapter.modifiedAt)}`}
        actions={
          <div className="inline-actions">
            {activeTask ? (
              <Button size="sm" variant="primary" onClick={continueTask}>
                继续现有验收任务
              </Button>
            ) : (
              <AsyncButton
                size="sm"
                variant="primary"
                busy={taskBusy}
                onClick={() => void createRevisionTask()}
              >
                {chapter.status === "final"
                  ? "为终稿创建新一轮修订"
                  : "创建终稿验收任务"}
              </AsyncButton>
            )}
          </div>
        }
      />

      {chapter.status === "final" && (
        <Alert
          variant="warning"
          showIcon
          title="作者确认终稿保持只读"
          description="如需修改，必须显式创建新一轮修订任务；工作台不会直接覆盖终稿。"
        />
      )}
      {chapter.healthIssues.map((issue, index) => (
        <Alert
          key={`${issue.code}-${issue.path ?? index}`}
          variant={issue.severity === "blocking" ? "error" : "warning"}
          showIcon
          title={issue.message}
          description={issue.path}
        />
      ))}

      {error && <Alert variant="error" showIcon title={error} />}
      {conflict && (
        <Alert
          variant="warning"
          showIcon
          title="正文已在外部发生变化，当前草稿仍保留"
          description="可先复制草稿，再重新读取磁盘版本；工作台不会覆盖外部修改。"
          action={
            <div className="inline-actions">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void copyDraft()}
              >
                复制草稿
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void reloadChapter()}
              >
                重新读取
              </Button>
            </div>
          }
        />
      )}

      {chapter.status !== "final" && (
        <div hidden={!editing}>
          <ChapterEditor
            active={editing}
            baselineContent={chapter.content}
            baselineVersion={chapter.sourceHash}
            path={chapter.path}
            previewBusy={mutationBusy}
            onDirtyChange={setDirty}
            onDraftChange={(content) => {
              setDraft(content);
              draftRef.current = content;
              if (preview?.kind === "edit") setPreview(null);
            }}
            onPreview={(content) => void previewEdit(content)}
          />
        </div>
      )}

      {!editing && (
        <>
          {dirty && (
            <Alert
              variant="info"
              showIcon
              title="当前预览包含未保存修改"
              description="切回编辑可继续修改；正式文件尚未写入。"
            />
          )}
          <ReaderNavigation chapter={chapter} position="上方" />

          <Panel className="reader-surface">
            <MarkdownContent className="novel-markdown">
              {readerContent}
            </MarkdownContent>
          </Panel>

          <ReaderNavigation chapter={chapter} position="下方" />
        </>
      )}

      <details className="engineering-details">
        <summary>工程信息</summary>
        <dl>
          <div>
            <dt>状态</dt>
            <dd>
              <StatusChip status={chapter.status} />
            </dd>
          </div>
          <div>
            <dt>正文路径</dt>
            <dd>{chapter.path}</dd>
          </div>
          <div>
            <dt>卷 ID / 章 ID</dt>
            <dd>
              {chapter.volumeId} / {chapter.chapterId}
            </dd>
          </div>
          <div>
            <dt>人工确认</dt>
            <dd>{chapter.humanApproved ? "是" : "否"}</dd>
          </div>
          {chapter.reviewGate && (
            <div>
              <dt>审稿门禁</dt>
              <dd>{chapter.reviewGate}</dd>
            </div>
          )}
        </dl>
      </details>

      <details className="danger-zone">
        <summary>归档章节</summary>
        <p>归档会把正文移入工作台回收站并更新卷状态表，不会永久删除。</p>
        <label>
          归档原因
          <input
            value={archiveReason}
            maxLength={500}
            onChange={(event) => setArchiveReason(event.target.value)}
          />
        </label>
        {chapter.status === "final" && (
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={confirmFinalArchive}
              onChange={(event) => setConfirmFinalArchive(event.target.checked)}
            />
            我确认这是终稿归档，且并非直接修改终稿
          </label>
        )}
        <AsyncButton
          size="sm"
          variant="outline"
          busy={mutationBusy}
          disabled={
            !archiveReason.trim() ||
            (chapter.status === "final" && !confirmFinalArchive)
          }
          onClick={() => void previewArchive()}
        >
          预览归档
        </AsyncButton>
      </details>

      <details className="danger-zone">
        <summary>删除章节</summary>
        <p>删除本章正文并更新卷状态表。工作台回收站无法恢复这章。</p>
        <AsyncButton size="sm" variant="danger" busy={mutationBusy} onClick={() => void previewDelete()}>
          预览删除章节
        </AsyncButton>
      </details>

      {preview && (
        <MutationPreviewDialog
          open
          title={preview.kind === "delete" ? "删除章节预览" : preview.kind === "archive" ? "归档章节预览" : "保存章节预览"}
          description={preview.kind === "delete" && dirty ? "确认后将删除正文，未保存的修改也会丢失。" : "确认后才会执行预览中列出的文件变更。"}
          preview={preview}
          busy={mutationBusy}
          confirmLabel={preview.kind === "delete" ? "永久删除章节" : preview.kind === "archive" ? "确认归档" : "确认写入"}
          confirmDeletion={preview.kind === "delete"}
          onOpenChange={(open) => !open && setPreview(null)}
          onConfirm={commitMutation}
        />
      )}
    </article>
  );
}
