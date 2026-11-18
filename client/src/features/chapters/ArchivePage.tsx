import { useEffect, useState } from "react";
import { Alert, Chip, Empty, Icon, Tabs } from "@ldkj/web-ui";
import type {
  ChapterArchiveEntry,
  ChapterMutationPreview,
  DocumentArchiveEntry,
  DocumentMutationPreview,
  VolumeArchiveEntry,
  VolumeMutationPreview,
} from "../../../../shared/contracts";
import { api } from "../../api";
import { useRepositorySession } from "../../app/RepositorySession";
import { AsyncButton } from "../../components/AsyncButton";
import { PageHeader, Panel } from "../../components/layout";
import { MutationPreviewDialog } from "../../components/MutationPreviewDialog";
import { ErrorState, LoadingState } from "../../components/states";
import { StatusChip } from "./ChapterRow";

type Archives = {
  volumes: VolumeArchiveEntry[];
  documents: DocumentArchiveEntry[];
  chapters: ChapterArchiveEntry[];
};

type ArchiveEntry = Archives[keyof Archives][number];

function ArchiveList<T extends ArchiveEntry>({
  entries,
  actionBusy,
  refreshing,
  onRestore,
}: {
  entries: T[];
  actionBusy: string;
  refreshing: boolean;
  onRestore(entry: T): void;
}) {
  return (
    <ul className="archive-list" role="list">
      {entries.map((entry) => (
        <li key={entry.id}>
          <div className="archive-record">
            <div className="archive-record-title">
              <strong>{entry.title}</strong>
              {"status" in entry && <StatusChip status={entry.status} />}
            </div>
            {"volumeNumber" in entry && (
              <small>
                第 {entry.volumeNumber} 卷 · {entry.volumeId}
              </small>
            )}
            {"chapterId" in entry && (
              <small>
                {entry.volumeId} / {entry.chapterId}
              </small>
            )}
            <code>{entry.originalPath}</code>
            {"authority" in entry && <code>{entry.archivePath}</code>}
          </div>
          <div className="archive-record-metadata">
            <time dateTime={entry.archivedAt}>
              {new Date(entry.archivedAt).toLocaleString("zh-CN")}
            </time>
            {entry.reason && <small>{entry.reason}</small>}
          </div>
          <div className="archive-actions">
            {entry.restorable ? (
              <AsyncButton
                size="sm"
                variant="primary"
                busy={actionBusy === entry.id}
                disabled={refreshing || Boolean(actionBusy)}
                onClick={() => onRestore(entry)}
              >
                预览恢复
              </AsyncButton>
            ) : entry.restoredAt ? (
              <Chip size="sm" variant="success">
                已恢复
              </Chip>
            ) : (
              <small>{entry.restoreIssue || "不可恢复"}</small>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function ArchivePage() {
  const { loadDashboard } = useRepositorySession();
  const [archives, setArchives] = useState<Archives | null>(null);
  const [preview, setPreview] = useState<ChapterMutationPreview | null>(null);
  const [volumePreview, setVolumePreview] =
    useState<VolumeMutationPreview | null>(null);
  const [documentPreview, setDocumentPreview] =
    useState<DocumentMutationPreview | null>(null);
  const [busy, setBusy] = useState(true);
  const [actionBusy, setActionBusy] = useState("");
  const [error, setError] = useState("");

  const load = async () => {
    setBusy(true);
    setError("");
    try {
      const [chapters, volumes, documents] = await Promise.all([
        api.chapterArchives(),
        api.volumeArchives(),
        api.documentArchives(),
      ]);
      setArchives({ chapters, volumes, documents });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取回收站");
    } finally {
      setBusy(false);
    }
  };

  const requestDocumentRestore = async (entry: DocumentArchiveEntry) => {
    setActionBusy(entry.id);
    setError("");
    try {
      setDocumentPreview(await api.previewDocumentRestore(entry.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法生成文档恢复预览");
    } finally {
      setActionBusy("");
    }
  };

  const commitDocumentRestore = async () => {
    if (!documentPreview) return;
    setActionBusy(documentPreview.archiveId ?? documentPreview.token);
    try {
      await api.commitDocumentMutation(
        documentPreview.token,
        documentPreview.confirmationRequirements,
      );
      setDocumentPreview(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "恢复文档失败");
      setDocumentPreview(null);
    } finally {
      setActionBusy("");
    }
  };

  const requestVolumeRestore = async (entry: VolumeArchiveEntry) => {
    setActionBusy(entry.id);
    setError("");
    try {
      setVolumePreview(await api.previewVolumeRestore(entry.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法生成卷恢复预览");
    } finally {
      setActionBusy("");
    }
  };

  const commitVolumeRestore = async () => {
    if (!volumePreview) return;
    setActionBusy(volumePreview.archiveId ?? volumePreview.token);
    try {
      await api.commitVolumeMutation(
        volumePreview.token,
        volumePreview.confirmationRequirements,
      );
      await loadDashboard();
      setVolumePreview(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "恢复卷失败");
      setVolumePreview(null);
    } finally {
      setActionBusy("");
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const requestRestore = async (entry: ChapterArchiveEntry) => {
    setActionBusy(entry.id);
    setError("");
    try {
      setPreview(await api.previewChapterRestore(entry.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法生成恢复预览");
    } finally {
      setActionBusy("");
    }
  };

  const commitRestore = async () => {
    if (!preview) return;
    setActionBusy(preview.archiveId ?? preview.token);
    try {
      await api.commitChapterMutation(
        preview.token,
        preview.confirmationRequirements,
      );
      setPreview(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "恢复章节失败");
      setPreview(null);
    } finally {
      setActionBusy("");
    }
  };

  const categories = archives && [
    {
      value: "volumes",
      label: "卷归档",
      icon: "book",
      count: archives.volumes.length,
      list: (
        <ArchiveList
          entries={archives.volumes}
          actionBusy={actionBusy}
          refreshing={busy}
          onRestore={requestVolumeRestore}
        />
      ),
    },
    {
      value: "documents",
      label: "文档归档",
      icon: "description",
      count: archives.documents.length,
      list: (
        <ArchiveList
          entries={archives.documents}
          actionBusy={actionBusy}
          refreshing={busy}
          onRestore={requestDocumentRestore}
        />
      ),
    },
    {
      value: "chapters",
      label: "章节归档",
      icon: "article",
      count: archives.chapters.length,
      list: (
        <ArchiveList
          entries={archives.chapters}
          actionBusy={actionBusy}
          refreshing={busy}
          onRestore={requestRestore}
        />
      ),
    },
  ];
  const firstWithRecords = categories?.find(({ count }) => count > 0);

  return (
    <div className="archive-page">
      <PageHeader
        eyebrow="可恢复归档"
        title="工作台回收站"
        description="查看归档记录并预览恢复。确认前会检查路径、哈希、身份和状态冲突。"
        actions={
          <AsyncButton
            variant="outline"
            size="sm"
            busy={busy}
            disabled={Boolean(actionBusy)}
            onClick={() => void load()}
          >
            <Icon name="refresh" size={16} />
            刷新
          </AsyncButton>
        }
      />
      {error && categories && (
        <div className="archive-feedback">
          <Alert variant="error" showIcon title={error} />
        </div>
      )}
      <Panel className="archive-panel">
        {categories ? (
          <Tabs
            defaultValue={firstWithRecords?.value ?? "volumes"}
            listProps={{ className: "archive-tabs", "aria-label": "归档类型" }}
            items={categories.map(({ value, label, icon, count, list }) => {
              const countLabel = count.toLocaleString();
              return {
                value,
                label: (
                  <>
                    <span className="archive-tab-icon" aria-hidden="true">
                      <Icon name={icon} size={17} />
                    </span>
                    <span>{label}</span>
                    <span className="archive-count">{countLabel}</span>
                  </>
                ),
                triggerProps: {
                  className: "archive-tab",
                  "aria-label": `${label} ${countLabel} 条记录`,
                },
                contentProps: {
                  className: "archive-tab-content",
                  borderless: true,
                },
                content:
                  count > 0 ? (
                    list
                  ) : (
                    <Empty
                      className="archive-empty"
                      image={
                        <span className="archive-empty-icon" aria-hidden="true">
                          <Icon name="archive" size={26} />
                        </span>
                      }
                      description={
                        <>
                          <strong>
                            {firstWithRecords
                              ? `暂无${label}记录`
                              : "回收站为空"}
                          </strong>
                          {!firstWithRecords && (
                            <p>归档的卷、文档和章节会显示在这里。</p>
                          )}
                        </>
                      }
                    />
                  ),
              };
            })}
          />
        ) : (
          <div className="archive-feedback">
            {busy ? (
              <LoadingState label="正在读取工作台回收站" />
            ) : (
              <ErrorState message={error} onRetry={() => void load()} />
            )}
          </div>
        )}
      </Panel>
      {preview && (
        <MutationPreviewDialog
          open
          title="恢复章节预览"
          description="确认后才会恢复正文、状态元数据并消费归档副本。"
          preview={preview}
          busy={Boolean(actionBusy)}
          confirmLabel="确认恢复"
          onOpenChange={(open) => !open && setPreview(null)}
          onConfirm={() => void commitRestore()}
        />
      )}
      {volumePreview && (
        <MutationPreviewDialog
          open
          title="恢复卷预览"
          description="确认后才会按原路径恢复正文、状态文件和归档范围内的规划资产。"
          preview={volumePreview}
          busy={Boolean(actionBusy)}
          diffTitle="恢复清单完整差异"
          confirmLabel="确认恢复卷"
          onOpenChange={(open) => !open && setVolumePreview(null)}
          onConfirm={() => void commitVolumeRestore()}
        />
      )}
      {documentPreview && (
        <MutationPreviewDialog
          open
          title="恢复文档预览"
          description="确认后才会按原路径恢复文档。"
          preview={documentPreview}
          busy={Boolean(actionBusy)}
          confirmLabel="确认恢复文档"
          onOpenChange={(open) => !open && setDocumentPreview(null)}
          onConfirm={() => void commitDocumentRestore()}
        />
      )}
    </div>
  );
}
