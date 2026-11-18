import { useEffect, useMemo, useState } from "react";
import { Alert, Button } from "@ldkj/web-ui";
import { useNavigate, useParams } from "react-router";
import { volumeHref } from "../../../../shared/reader-paths";
import { ApiRequestError, api } from "../../api";
import { useRepositorySession } from "../../app/RepositorySession";
import { useUnsavedChangesGuard } from "../../app/UnsavedChangesContext";
import { BreadcrumbTrail } from "../../components/BreadcrumbTrail";
import { PageHeader, Panel } from "../../components/layout";
import { MutationPreviewDialog } from "../../components/MutationPreviewDialog";
import { ErrorState, LoadingState } from "../../components/states";
import type {
  VolumeDetail,
  VolumeMutationPreview,
} from "../../../../shared/contracts";
import { VolumeForm, type VolumeFormValues } from "./VolumeForm";

type EditableVolumeDetail = VolumeDetail;

function formValues(volume: EditableVolumeDetail): VolumeFormValues {
  return {
    title: volume.title,
  };
}

/** 修改卷名；不可变卷身份只读展示。 */
export function VolumeEditPage() {
  const { volumeId = "" } = useParams();
  const navigate = useNavigate();
  const { loadDashboard } = useRepositorySession();
  const [volume, setVolume] = useState<EditableVolumeDetail | null>(null);
  const [values, setValues] = useState<VolumeFormValues | null>(null);
  const [preview, setPreview] = useState<VolumeMutationPreview | null>(null);
  const [busy, setBusy] = useState(true);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [commitBusy, setCommitBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState("");
  const dirty = useMemo(
    () => Boolean(volume && values && values.title !== volume.title),
    [values, volume],
  );
  useUnsavedChangesGuard(dirty && !leaving);

  const load = async () => {
    setBusy(true);
    setError("");
    try {
      const loaded = (await api.volume(volumeId)) as EditableVolumeDetail;
      setVolume(loaded);
      setValues(formValues(loaded));
      setConflict(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取卷资料");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
  }, [volumeId]);

  const requestPreview = async () => {
    if (!volume || !values) return;
    setPreviewBusy(true);
    setError("");
    setConflict(false);
    try {
      setPreview(await api.previewVolumeEdit(volume.id, values.title.trim()));
    } catch (cause) {
      setConflict(
        cause instanceof ApiRequestError &&
          ["SOURCE_CHANGED", "MUTATION_CONFLICT"].includes(cause.code),
      );
      setError(cause instanceof Error ? cause.message : "无法生成修改预览");
    } finally {
      setPreviewBusy(false);
    }
  };

  const commit = async () => {
    if (!preview) return;
    setCommitBusy(true);
    setError("");
    try {
      const result = await api.commitVolumeMutation(
        preview.token,
        preview.confirmationRequirements,
      );
      await loadDashboard();
      setLeaving(true);
      navigate(result.destinationHref, { replace: true });
    } catch (cause) {
      setConflict(
        cause instanceof ApiRequestError && cause.code === "MUTATION_CONFLICT",
      );
      setError(cause instanceof Error ? cause.message : "修改卷资料失败");
      setPreview(null);
    } finally {
      setCommitBusy(false);
    }
  };

  if (busy) return <LoadingState label="正在读取卷资料" />;
  if (!volume || !values)
    return <ErrorState message={error || "无法读取卷资料"} />;
  return (
    <div className="volume-write-page">
      <BreadcrumbTrail
        items={[
          { label: "章节总览", to: "/chapters" },
          {
            label: volume.title,
            to: volumeHref(volume.id),
          },
          { label: "编辑卷资料" },
        ]}
      />
      <PageHeader
        eyebrow={`${volume.id} · 第 ${volume.number} 卷`}
        title="编辑卷资料"
        description="修改卷名只更新状态 YAML；纯 ID 目录、卷号和所有长期引用保持不变。"
      />
      {error && <Alert variant="error" showIcon title={error} />}
      {conflict && (
        <Alert
          variant="warning"
          showIcon
          title="状态文件已在外部发生变化，当前输入仍保留"
          description="请先核对输入，再重新读取磁盘版本；工作台不会覆盖外部修改。"
          action={
            <Button size="sm" variant="outline" onClick={() => void load()}>
              重新读取
            </Button>
          }
        />
      )}
      <Panel>
        <VolumeForm
          mode="edit"
          volumeId={volume.id}
          volumeNumber={volume.number}
          targetPath={`40_正文/卷/${volume.id}/状态.yaml`}
          values={values}
          busy={previewBusy}
          onChange={(next) => {
            setValues(next);
            setPreview(null);
          }}
          onSubmit={() => void requestPreview()}
        />
      </Panel>
      {preview && (
        <MutationPreviewDialog
          open
          title="卷名修改预览"
          description="确认后只替换状态 YAML，不移动任何目录。"
          preview={preview}
          busy={commitBusy}
          diffTitle="状态 YAML 完整差异"
          confirmLabel="确认修改卷名"
          onOpenChange={(open) => !open && setPreview(null)}
          onConfirm={() => void commit()}
        />
      )}
    </div>
  );
}
