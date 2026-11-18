import { useEffect, useState } from "react";
import { Alert, Button, Chip, Input } from "@ldkj/web-ui";
import { Link, useNavigate, useSearchParams } from "react-router";
import type {
  DocumentDetail,
  DocumentMutationPreview,
} from "../../../../shared/contracts";
import { ApiRequestError, api } from "../../api";
import { useRepositorySession } from "../../app/RepositorySession";
import { useUnsavedChangesGuard } from "../../app/UnsavedChangesContext";
import { AsyncButton } from "../../components/AsyncButton";
import { BreadcrumbTrail } from "../../components/BreadcrumbTrail";
import { PageHeader, Panel } from "../../components/layout";
import { MarkdownContent } from "../../components/MarkdownContent";
import { MutationPreviewDialog } from "../../components/MutationPreviewDialog";
import { Textarea } from "../../components/Textarea";
import { ErrorState, LoadingState } from "../../components/states";
import { authorityLabel } from "../../domain/authority";
import { stripLeadingChapterH1 } from "../chapters/chapterNavigation";

function fileName(path: string): string {
  return (
    path
      .split(/[\\/]/)
      .at(-1)
      ?.replace(/\.[^.]+$/, "") || "工程文档"
  );
}

function markdownTitle(content: string): string | undefined {
  return /^(?:\uFEFF)?(?:[\t ]*\r?\n)*[\t ]*#(?!#)[\t ]+([^\r\n]+)/
    .exec(content)?.[1]
    ?.trim();
}

export function DocumentDetailPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedPath = searchParams.get("path")?.trim() ?? "";
  const { showNotice } = useRepositorySession();
  const [document, setDocument] = useState<DocumentDetail | null>(null);
  const [busy, setBusy] = useState(Boolean(requestedPath));
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [mutationBusy, setMutationBusy] = useState(false);
  const [preview, setPreview] = useState<DocumentMutationPreview | null>(null);
  const [archiveReason, setArchiveReason] = useState("");
  const [leaving, setLeaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const dirty = Boolean(document && editing && draft !== document.content);
  useUnsavedChangesGuard(dirty && !leaving);

  useEffect(() => {
    let cancelled = false;
    setDocument(null);
    setError("");
    if (!requestedPath) {
      setBusy(false);
      setError("地址中缺少文档路径");
      return () => {
        cancelled = true;
      };
    }
    setBusy(true);
    void api
      .document(requestedPath)
      .then((loaded) => {
        if (!cancelled) {
          setDocument(loaded);
          setDraft(loaded.content);
          setEditing(false);
        }
      })
      .catch((cause) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : "无法读取文档");
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [requestedPath]);

  const requestEditPreview = async () => {
    if (!document || !document.capabilities?.editable || !dirty) return;
    setMutationBusy(true);
    setError("");
    setConflict(false);
    try {
      setPreview(
        await api.previewDocumentEdit(
          document.path,
          draft,
          document.sourceHash,
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
  };

  useEffect(() => {
    if (!dirty) return;
    const handleSave = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() === "s" &&
        (event.ctrlKey || event.metaKey) &&
        !event.altKey
      ) {
        event.preventDefault();
        void requestEditPreview();
      }
    };
    window.addEventListener("keydown", handleSave);
    return () => window.removeEventListener("keydown", handleSave);
  });

  const requestArchivePreview = async () => {
    if (!document || !document.capabilities?.archivable) return;
    setMutationBusy(true);
    setError("");
    try {
      setPreview(
        await api.previewDocumentArchive(
          document.path,
          archiveReason,
          document.sourceHash,
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
    try {
      const result = await api.commitDocumentMutation(
        preview.token,
        preview.confirmationRequirements,
      );
      setPreview(null);
      if (result.kind === "archive") {
        setLeaving(true);
        navigate(result.destinationHref, { replace: true });
      } else if (result.document) {
        setDocument(result.document);
        setDraft(result.document.content);
        setEditing(false);
        setConflict(false);
        showNotice({ tone: "success", message: "Markdown 文档已安全写入。" });
      }
    } catch (cause) {
      setConflict(
        cause instanceof ApiRequestError && cause.code === "MUTATION_CONFLICT",
      );
      setError(cause instanceof Error ? cause.message : "文档操作失败");
      setPreview(null);
    } finally {
      setMutationBusy(false);
    }
  };

  const reloadDocument = async () => {
    if (!document) return;
    setMutationBusy(true);
    try {
      const loaded = await api.document(document.path);
      setDocument(loaded);
      setDraft(loaded.content);
      setConflict(false);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "重新读取文档失败");
    } finally {
      setMutationBusy(false);
    }
  };

  const openDocument = async (target: "folder") => {
    if (!document) return;
    try {
      await api.open(document.path, target);
      showNotice({
        tone: "success",
        message: "已请求打开文档所在目录。",
      });
    } catch (cause) {
      showNotice({
        tone: "error",
        message: cause instanceof Error ? cause.message : "打开文档失败",
      });
    }
  };

  if (busy) return <LoadingState label="正在读取工程文档" />;
  if (error || !document)
    return (
      <>
        <PageHeader
          eyebrow="文档阅读"
          title="无法打开文档"
          description="请检查链接中的仓库相对路径。"
        />
        <ErrorState message={error || "文档不存在"} />
      </>
    );

  const isMarkdown = /\.md$/i.test(document.path);
  const title =
    (isMarkdown ? markdownTitle(document.content) : undefined) ??
    fileName(document.path);
  const content = isMarkdown
    ? stripLeadingChapterH1(document.content)
    : document.content;

  return (
    <article className="document-reader">
      <BreadcrumbTrail
        items={[{ label: "文档库", to: "/documents" }, { label: title }]}
      />
      <PageHeader
        eyebrow={document.capabilities?.editable ? "工程文档" : "只读工程文档"}
        title={title}
        description={document.path}
        actions={
          <div className="inline-actions">
            <Button
              className="button-link"
              component={Link}
              to="/documents"
              size="sm"
              variant="outline"
            >
              返回文档库
            </Button>
            {document.capabilities?.editable && !editing && (
              <Button
                size="sm"
                variant="primary"
                onClick={() => setEditing(true)}
              >
                编辑 Markdown
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void openDocument("folder")}
            >
              打开所在目录
            </Button>
          </div>
        }
      />
      <div className="document-authority">
        <Chip
          size="sm"
          variant={
            document.authority === "canonical" || document.authority === "bible"
              ? "success"
              : document.authority === "archive"
                ? "danger"
                : "default"
          }
        >
          {authorityLabel(document.authority)}
        </Chip>
        {(document.warning || document.authority === "archive") && (
          <Alert
            variant="warning"
            showIcon
            description={
              document.warning ??
              "归档内容不是当前事实来源，请勿将其误认为现行设定。"
            }
          />
        )}
      </div>
      {error && <Alert variant="error" showIcon title={error} />}
      {conflict && (
        <Alert
          variant="warning"
          showIcon
          title="文档已在外部发生变化，当前草稿仍保留"
          description="请先复制草稿，再重新读取磁盘版本；工作台不会覆盖外部修改。"
          action={
            <div className="inline-actions">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void navigator.clipboard.writeText(draft)}
              >
                复制草稿
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void reloadDocument()}
              >
                重新读取
              </Button>
            </div>
          }
        />
      )}
      {editing && document.capabilities?.editable && (
        <section
          className="document-editor"
          aria-labelledby="document-editor-title"
        >
          <div className="document-editor-header">
            <div>
              <h2 id="document-editor-title">编辑 Markdown 原文</h2>
              <p>正式保存前会展示完整差异。</p>
            </div>
            <span aria-live="polite">{dirty ? "有未保存修改" : "已保存"}</span>
          </div>
          <Textarea
            aria-label="文档 Markdown 原文"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setPreview(null);
            }}
          />
          <div className="document-form-actions">
            <Button
              type="button"
              variant="ghost"
              disabled={mutationBusy}
              onClick={() => {
                setDraft(document.content);
                setEditing(false);
              }}
            >
              取消编辑
            </Button>
            <AsyncButton
              type="button"
              variant="primary"
              busy={mutationBusy}
              disabled={!dirty}
              onClick={() => void requestEditPreview()}
            >
              预览保存
            </AsyncButton>
          </div>
        </section>
      )}
      <Panel className="reader-surface">
        {isMarkdown ? (
          <MarkdownContent>{content}</MarkdownContent>
        ) : (
          <pre className="plain-document">{content}</pre>
        )}
      </Panel>
      {document.capabilities?.archivable && (
        <details className="danger-zone">
          <summary>归档文档</summary>
          <p>文档将移入工作台回收站，不会永久删除。</p>
          <label>
            归档原因
            <Input
              value={archiveReason}
              maxLength={500}
              onChange={(event) => setArchiveReason(event.target.value)}
            />
          </label>
          <AsyncButton
            size="sm"
            variant="outline"
            busy={mutationBusy}
            disabled={!archiveReason.trim() || dirty}
            onClick={() => void requestArchivePreview()}
          >
            预览归档
          </AsyncButton>
        </details>
      )}
      {preview && (
        <MutationPreviewDialog
          open
          title={preview.kind === "archive" ? "归档文档预览" : "保存文档预览"}
          description="确认后才会执行预览中列出的文件变更。"
          preview={preview}
          busy={mutationBusy}
          confirmLabel={preview.kind === "archive" ? "确认归档" : "确认写入"}
          onOpenChange={(open) => !open && setPreview(null)}
          onConfirm={() => void commitMutation()}
        />
      )}
    </article>
  );
}
