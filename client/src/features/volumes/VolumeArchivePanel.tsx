import { useState } from "react";
import { Alert, Input } from "@ldkj/web-ui";
import { useNavigate } from "react-router";
import type {
  VolumeDetail,
  VolumeMutationPreview,
} from "../../../../shared/contracts";
import { api } from "../../api";
import { useRepositorySession } from "../../app/RepositorySession";
import { AsyncButton } from "../../components/AsyncButton";
import { MutationPreviewDialog } from "../../components/MutationPreviewDialog";

type ArchivableVolumeDetail = VolumeDetail;

/** 卷详情页的可恢复归档入口。 */
export function VolumeArchivePanel({
  volume,
}: {
  volume: ArchivableVolumeDetail;
}) {
  const navigate = useNavigate();
  const { loadDashboard } = useRepositorySession();
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<VolumeMutationPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const requestPreview = async (kind: "archive" | "delete") => {
    setBusy(true);
    setError("");
    try {
      setPreview(
        kind === "delete"
          ? await api.previewVolumeDelete(volume.id)
          : await api.previewVolumeArchive(volume.id, reason.trim()),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法生成卷操作预览");
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.commitVolumeMutation(
        preview.token,
        preview.confirmationRequirements,
      );
      await loadDashboard();
      navigate(result.destinationHref, { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "卷操作失败");
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };

  const deleting = preview?.kind === "delete";
  return (
    <>
      {volume.chapterCount > 0 ? (
        <section
          className="danger-zone volume-archive-panel"
          aria-labelledby="archive-volume-title"
        >
          <h2 id="archive-volume-title">归档卷</h2>
          <Alert
            variant="warning"
            showIcon
            title="当前卷非空，不能归档"
            description={`本卷仍有 ${volume.chapterCount.toLocaleString()} 章${volume.finalCount > 0 ? `，其中 ${volume.finalCount.toLocaleString()} 章为终稿` : ""}。归档仅适用于空卷。`}
          />
        </section>
      ) : (
        <details className="danger-zone volume-archive-panel">
          <summary>归档卷</summary>
          <p>
            归档会把本卷正文及其拥有的规划资产移入工作台回收站，不会永久删除；生产、审稿和发布引用会在预览中列出。
          </p>
          <label>
            归档原因
            <Input
              value={reason}
              maxLength={500}
              disabled={busy}
              onChange={(event) => {
                setReason(event.target.value);
                setPreview(null);
              }}
            />
          </label>
          <AsyncButton
            size="sm"
            variant="danger"
            busy={busy}
            disabled={!reason.trim()}
            onClick={() => void requestPreview("archive")}
          >
            预览归档影响
          </AsyncButton>
        </details>
      )}
      <details className="danger-zone volume-archive-panel">
        <summary>删除卷</summary>
        <p>
          删除整卷的正文、状态文件和自有规划资产。工作台回收站无法恢复这些文件。
        </p>
        <AsyncButton
          size="sm"
          variant="danger"
          busy={busy}
          onClick={() => void requestPreview("delete")}
        >
          预览删除整卷
        </AsyncButton>
      </details>
      {error && <Alert variant="error" showIcon title={error} />}
      {preview && (
        <MutationPreviewDialog
          open
          title={deleting ? "删除卷预览" : "归档卷预览"}
          description={
            deleting
              ? "确认后永久删除预览中的文件。"
              : "阻断引用必须先处理；其余影响需逐项确认后才能归档。"
          }
          preview={preview}
          busy={busy}
          diffTitle={deleting ? "卷状态文件差异" : "归档清单完整差异"}
          confirmLabel={deleting ? "永久删除整卷" : "确认归档整卷"}
          confirmDeletion={deleting}
          onOpenChange={(open) => !open && setPreview(null)}
          onConfirm={commit}
        />
      )}
    </>
  );
}
