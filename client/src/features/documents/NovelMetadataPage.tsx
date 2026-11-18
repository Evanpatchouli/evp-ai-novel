import { useEffect, useState } from "react";
import { Alert, Button, Form, Input, Uploader } from "@ldkj/web-ui";
import { Link, useNavigate } from "react-router";
import type {
  NovelMetadataDetail,
  NovelMetadataPreview,
} from "../../../../shared/contracts";
import { api, type NovelMetadataValues } from "../../api";
import { useRepositorySession } from "../../app/RepositorySession";
import { useUnsavedChangesGuard } from "../../app/UnsavedChangesContext";
import { BreadcrumbTrail } from "../../components/BreadcrumbTrail";
import { MutationPreviewDialog } from "../../components/MutationPreviewDialog";
import { Textarea } from "../../components/Textarea";
import { PageHeader, Panel } from "../../components/layout";
import { LoadingState } from "../../components/states";

const EMPTY_VALUES: NovelMetadataValues = {
  title: "示例小说",
  author: "",
  description: "",
  currentVolume: "",
  currentChapter: "",
};
const MAX_COVER_BYTES = 5 * 1024 * 1024;

function valuesOf(detail: NovelMetadataDetail): NovelMetadataValues {
  return {
    title: detail.metadata.novel.title,
    author: detail.metadata.novel.author,
    description: detail.metadata.novel.description,
    currentVolume: detail.metadata.novel.current_volume ?? "",
    currentChapter: detail.metadata.novel.current_chapter ?? "",
  };
}

export function NovelMetadataPage() {
  const navigate = useNavigate();
  const { loadDashboard, showNotice } = useRepositorySession();
  const [detail, setDetail] = useState<NovelMetadataDetail | null>(null);
  const [values, setValues] = useState<NovelMetadataValues>(EMPTY_VALUES);
  const [preview, setPreview] = useState<NovelMetadataPreview | null>(null);
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [coverUploaderKey, setCoverUploaderKey] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const baseline = detail ? valuesOf(detail) : EMPTY_VALUES;
  const dirty =
    JSON.stringify(values) !== JSON.stringify(baseline) || coverFile !== null;
  useUnsavedChangesGuard(dirty);

  useEffect(() => {
    void api
      .novelMetadata()
      .then((loaded) => {
        setDetail(loaded);
        setValues(valuesOf(loaded));
      })
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : "无法读取小说元数据"),
      )
      .finally(() => setBusy(false));
  }, []);

  const requestPreview = async () => {
    setBusy(true);
    setError("");
    try {
      setPreview(
        await api.previewNovelMetadata(
          values,
          detail?.sourceHash,
          coverFile ?? undefined,
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法生成元数据预览");
    } finally {
      setBusy(false);
    }
  };
  const commit = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const result = await api.commitNovelMetadata(
        preview.token,
        preview.confirmationRequirements,
      );
      setDetail(result.novel);
      setValues(valuesOf(result.novel));
      setCoverFile(null);
      setCoverUploaderKey((value) => value + 1);
      setPreview(null);
      await loadDashboard();
      showNotice({ tone: "success", message: "小说元数据已安全写入。" });
      navigate(result.destinationHref, { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "小说元数据写入失败");
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };

  if (busy && !detail) return <LoadingState label="正在读取小说元数据" />;
  return (
    <div className="novel-metadata-page">
      <BreadcrumbTrail
        items={[{ label: "文档库", to: "/documents" }, { label: "小说元数据" }]}
      />
      <PageHeader
        eyebrow="结构化 YAML"
        title="小说元数据"
        description={
          detail?.exists
            ? detail.path
            : "元数据文件尚未创建；现有仓库仍可兼容读取。"
        }
        actions={
          <Button
            className="button-link"
            component={Link}
            to="/documents"
            variant="outline"
          >
            返回文档库
          </Button>
        }
      />
      {!detail?.exists && (
        <Alert
          variant="info"
          showIcon
          title="可选元数据尚不存在"
          description="只有明确确认预览后才会创建 00_项目/小说.yaml。"
        />
      )}
      {error && <Alert variant="error" showIcon title={error} />}
      <Panel>
        <Form
          className="novel-metadata-form"
          onSubmit={(event) => {
            event.preventDefault();
            void requestPreview();
          }}
        >
          <Form.Item label="小说 ID" help="固定身份，不可修改">
            <Input value={detail?.metadata.novel.id ?? ""} disabled />
          </Form.Item>
          <Form.Item label="书名" required>
            <Input
              aria-label="书名"
              value={values.title}
              disabled={busy}
              onChange={(event) =>
                setValues({ ...values, title: event.target.value })
              }
            />
          </Form.Item>
          <Form.Item label="作者">
            <Input
              aria-label="作者"
              value={values.author}
              disabled={busy}
              onChange={(event) =>
                setValues({ ...values, author: event.target.value })
              }
            />
          </Form.Item>
          <Form.Item
            label="封面"
            help="仅支持不超过 5 MiB 的 PNG；确认后固定保存到 70_素材/封面.png。"
          >
            <div className="novel-cover-field">
              {detail?.metadata.novel.cover && !coverFile && (
                <span className="muted-copy">
                  当前封面：{detail.metadata.novel.cover}
                </span>
              )}
              <Uploader
                key={coverUploaderKey}
                accept="image/png,.png"
                autoUpload={false}
                disabled={busy}
                listType="picture"
                maxCount={1}
                maxSize={MAX_COVER_BYTES}
                multiple={false}
                onFileListChange={(_files, meta) => {
                  if (meta.reason === "add")
                    setCoverFile(meta.file?.originFile ?? null);
                  if (meta.reason === "remove") setCoverFile(null);
                }}
                onReject={(_file, reason) =>
                  setError(
                    reason === "maxSize"
                      ? "封面不能超过 5 MiB"
                      : "封面必须是 PNG 文件",
                  )
                }
              >
                <Button type="button" variant="outline">
                  选择 PNG 封面
                </Button>
              </Uploader>
            </div>
          </Form.Item>
          <label className="document-content-field">
            <span>简介</span>
            <Textarea
              aria-label="小说简介"
              value={values.description}
              disabled={busy}
              onChange={(event) =>
                setValues({ ...values, description: event.target.value })
              }
            />
          </label>
          <div className="novel-progress-fields">
            <Form.Item label="当前卷 ID">
              <Input
                aria-label="当前卷 ID"
                value={values.currentVolume}
                disabled={busy}
                onChange={(event) =>
                  setValues({ ...values, currentVolume: event.target.value })
                }
              />
            </Form.Item>
            <Form.Item label="当前章 ID">
              <Input
                aria-label="当前章 ID"
                value={values.currentChapter}
                disabled={busy}
                onChange={(event) =>
                  setValues({ ...values, currentChapter: event.target.value })
                }
              />
            </Form.Item>
          </div>
          <div className="document-form-actions">
            <Button
              type="submit"
              variant="primary"
              disabled={busy || !dirty || !values.title.trim()}
            >
              预览 YAML 变更
            </Button>
          </div>
        </Form>
      </Panel>
      {preview && (
        <MutationPreviewDialog
          open
          title={
            preview.kind === "create"
              ? "创建小说元数据预览"
              : "修改小说元数据预览"
          }
          description="YAML 允许规范化保存，请核对完整差异。"
          diffTitle="YAML 完整差异"
          preview={preview}
          busy={busy}
          onOpenChange={(open) => !open && setPreview(null)}
          onConfirm={() => void commit()}
        />
      )}
    </div>
  );
}
