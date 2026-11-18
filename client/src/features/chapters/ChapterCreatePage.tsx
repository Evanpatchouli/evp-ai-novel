import { useEffect, useState } from "react";
import { Alert } from "@ldkj/web-ui";
import { useNavigate, useParams } from "react-router";
import type {
  ChapterCreateDefaults,
  ChapterMutationPreview,
} from "../../../../shared/contracts";
import { volumeHref } from "../../../../shared/reader-paths";
import { api } from "../../api";
import { useUnsavedChangesGuard } from "../../app/UnsavedChangesContext";
import { BreadcrumbTrail } from "../../components/BreadcrumbTrail";
import { PageHeader } from "../../components/layout";
import { MutationPreviewDialog } from "../../components/MutationPreviewDialog";
import { ErrorState, LoadingState } from "../../components/states";
import { ChapterEditor } from "./ChapterEditor";

export function ChapterCreatePage() {
  const { volumeId = "" } = useParams();
  const navigate = useNavigate();
  const [defaults, setDefaults] = useState<ChapterCreateDefaults | null>(null);
  const [preview, setPreview] = useState<ChapterMutationPreview | null>(null);
  const [dirty, setDirty] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState(true);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [commitBusy, setCommitBusy] = useState(false);
  const [error, setError] = useState("");
  useUnsavedChangesGuard(dirty && !leaving);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError("");
    void api
      .chapterCreateDefaults(volumeId)
      .then((value) => {
        if (!cancelled) setDefaults(value);
      })
      .catch((cause) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : "无法准备新章节");
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [volumeId]);

  const requestPreview = async (content: string) => {
    setPreviewBusy(true);
    setError("");
    try {
      setPreview(await api.previewChapterCreate(volumeId, content));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法生成创建预览");
    } finally {
      setPreviewBusy(false);
    }
  };

  const commit = async () => {
    if (!preview) return;
    setCommitBusy(true);
    setError("");
    try {
      const result = await api.commitChapterMutation(
        preview.token,
        preview.confirmationRequirements,
      );
      setLeaving(true);
      setDirty(false);
      navigate(result.destinationHref, { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "创建章节失败");
      setPreview(null);
    } finally {
      setCommitBusy(false);
    }
  };

  if (busy) return <LoadingState label="正在准备新章节" />;
  if (!defaults) return <ErrorState message={error || "无法准备新章节"} />;

  return (
    <div className="chapter-write-page">
      <BreadcrumbTrail
        items={[
          { label: "章节总览", to: "/chapters" },
          {
            label: defaults.volumeId,
            to: volumeHref(defaults.volumeId),
          },
          { label: `新建 ${defaults.chapterId}` },
        ]}
      />
      <PageHeader
        eyebrow={`${defaults.volumeId} · ${defaults.chapterId}`}
        title="在卷末新建章节"
        description="章 ID 由全书历史最大编号递增生成；保存会同时更新卷状态表。"
      />
      {error && <Alert variant="error" showIcon title={error} />}
      <ChapterEditor
        autoFocus
        baselineContent={defaults.initialContent}
        baselineVersion={defaults.chapterId}
        path={defaults.targetPath}
        previewBusy={previewBusy}
        onDirtyChange={setDirty}
        onPreview={(content) => void requestPreview(content)}
      />
      {preview && (
        <MutationPreviewDialog
          open
          title="创建章节预览"
          description="确认后才会创建 Markdown 并更新卷状态表。"
          preview={preview}
          busy={commitBusy}
          onOpenChange={(open) => !open && setPreview(null)}
          onConfirm={() => void commit()}
        />
      )}
    </div>
  );
}
