import { useEffect, useMemo, useState } from "react";
import { Alert } from "@ldkj/web-ui";
import { useNavigate } from "react-router";
import type { VolumeCreateDefaults, VolumeMutationPreview } from "../../../../shared/contracts";
import { api } from "../../api";
import { useRepositorySession } from "../../app/RepositorySession";
import { useUnsavedChangesGuard } from "../../app/UnsavedChangesContext";
import { BreadcrumbTrail } from "../../components/BreadcrumbTrail";
import { PageHeader, Panel } from "../../components/layout";
import { MutationPreviewDialog } from "../../components/MutationPreviewDialog";
import { ErrorState, LoadingState } from "../../components/states";
import { VolumeForm, type VolumeFormValues } from "./VolumeForm";

const INITIAL_VALUES: VolumeFormValues = {
  title: "",
};

/** 在服务端分配的不可变身份下创建一卷。 */
export function VolumeCreatePage() {
  const navigate = useNavigate();
  const { loadDashboard } = useRepositorySession();
  const [defaults, setDefaults] = useState<VolumeCreateDefaults | null>(null);
  const [values, setValues] = useState(INITIAL_VALUES);
  const [preview, setPreview] = useState<VolumeMutationPreview | null>(null);
  const [busy, setBusy] = useState(true);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [commitBusy, setCommitBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState("");
  const dirty = useMemo(() => JSON.stringify(values) !== JSON.stringify(INITIAL_VALUES), [values]);
  useUnsavedChangesGuard(dirty && !leaving);

  useEffect(() => {
    let cancelled = false;
    void api
      .volumeCreateDefaults()
      .then((loaded) => {
        if (!cancelled) setDefaults(loaded);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "无法准备新卷");
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const requestPreview = async () => {
    setPreviewBusy(true);
    setError("");
    try {
      setPreview(await api.previewVolumeCreate(values.title.trim()));
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
      const result = await api.commitVolumeMutation(preview.token, preview.confirmationRequirements);
      await loadDashboard();
      setLeaving(true);
      navigate(result.destinationHref, { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "创建卷失败");
      setPreview(null);
    } finally {
      setCommitBusy(false);
    }
  };

  if (busy) return <LoadingState label="正在准备新卷" />;
  if (!defaults) return <ErrorState message={error || "无法准备新卷"} />;
  return (
    <div className="volume-write-page">
      <BreadcrumbTrail items={[{ label: "章节总览", to: "/chapters" }, { label: `新建 ${defaults.volumeId}` }]} />
      <PageHeader
        eyebrow={`${defaults.volumeId} · 第 ${defaults.volumeNumber} 卷`}
        title="新建卷"
        description="卷身份由全书现有结构分配；所有文件只有在预览确认后才会创建。"
      />
      {error && <Alert variant="error" showIcon title={error} />}
      <Panel>
        <VolumeForm
          mode="create"
          volumeId={defaults.volumeId}
          volumeNumber={defaults.volumeNumber}
          targetPath={defaults.targetPath}
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
          title="创建卷预览"
          description="确认后才会创建纯 ID 卷目录和结构化状态文件。"
          preview={preview}
          busy={commitBusy}
          diffTitle="状态 YAML 完整差异"
          confirmLabel="确认创建卷"
          onOpenChange={(open) => !open && setPreview(null)}
          onConfirm={() => void commit()}
        />
      )}
    </div>
  );
}
