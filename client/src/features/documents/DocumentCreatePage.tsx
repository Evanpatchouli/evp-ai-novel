import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Form, Input } from "@ldkj/web-ui";
import { Link, useNavigate } from "react-router";
import type {
  DocumentMutationPreview,
  DocumentTreeNode,
} from "../../../../shared/contracts";
import { api } from "../../api";
import { useUnsavedChangesGuard } from "../../app/UnsavedChangesContext";
import { BreadcrumbTrail } from "../../components/BreadcrumbTrail";
import { MutationPreviewDialog } from "../../components/MutationPreviewDialog";
import { SelectField } from "../../components/SelectField";
import { Textarea } from "../../components/Textarea";
import { PageHeader, Panel } from "../../components/layout";
import { LoadingState } from "../../components/states";

function creatableDirectories(nodes: DocumentTreeNode[]): DocumentTreeNode[] {
  return nodes.flatMap((node) => [
    ...(node.kind === "directory" && node.capabilities.creatable ? [node] : []),
    ...creatableDirectories(node.children ?? []),
  ]);
}

export function DocumentCreatePage() {
  const navigate = useNavigate();
  const [nodes, setNodes] = useState<DocumentTreeNode[] | null>(null);
  const [directory, setDirectory] = useState("");
  const [name, setName] = useState("");
  const [content, setContent] = useState("# ");
  const [preview, setPreview] = useState<DocumentMutationPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState("");
  useUnsavedChangesGuard(!leaving && Boolean(name.trim() || content !== "# "));

  useEffect(() => {
    void api
      .documentTree()
      .then(setNodes)
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : "无法读取可创建目录"),
      );
  }, []);
  const directories = useMemo(() => creatableDirectories(nodes ?? []), [nodes]);
  useEffect(() => {
    if (!directory && directories[0]) setDirectory(directories[0].path);
  }, [directories, directory]);
  const normalizedName = name.trim().replace(/\.md$/i, "");
  const validName = Boolean(normalizedName) && !/[\\/]/.test(normalizedName);
  const targetPath =
    directory && validName
      ? `${directory}/${normalizedName}.md`
      : "请选择目录并输入文件名";

  const requestPreview = async () => {
    if (!directory || !validName || !content.trim()) return;
    setBusy(true);
    setError("");
    try {
      setPreview(await api.previewDocumentCreate(targetPath, content));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法生成创建预览");
    } finally {
      setBusy(false);
    }
  };
  const commit = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const result = await api.commitDocumentMutation(
        preview.token,
        preview.confirmationRequirements,
      );
      setLeaving(true);
      navigate(result.destinationHref, { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "创建文档失败");
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };

  if (!nodes && !error) return <LoadingState label="正在读取文档目录" />;
  return (
    <div className="document-write-page">
      <BreadcrumbTrail
        items={[{ label: "文档库", to: "/documents" }, { label: "新建文档" }]}
      />
      <PageHeader
        eyebrow="Markdown 文档"
        title="新建工程文档"
        description="只能在服务端允许的权威目录中创建普通 Markdown 文档。"
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
      {error && <Alert variant="error" showIcon title={error} />}
      <Panel>
        <Form
          className="document-form"
          onSubmit={(event) => {
            event.preventDefault();
            void requestPreview();
          }}
        >
          <SelectField
            label="所属目录"
            value={directory}
            disabled={busy}
            options={directories.map((node) => ({
              label: node.path,
              value: node.path,
            }))}
            onValueChange={setDirectory}
          />
          <Form.Item
            label="文件名"
            required
            help={
              name && !validName
                ? "文件名不能包含目录分隔符。"
                : "无需输入 .md 扩展名。"
            }
            validateStatus={name && !validName ? "error" : undefined}
          >
            <Input
              aria-label="文档文件名"
              value={name}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </Form.Item>
          <dl className="document-target-path">
            <div>
              <dt>目标路径</dt>
              <dd>{targetPath}</dd>
            </div>
          </dl>
          <label className="document-content-field">
            <span>Markdown 原文</span>
            <Textarea
              aria-label="文档 Markdown 原文"
              value={content}
              disabled={busy}
              onChange={(event) => setContent(event.target.value)}
            />
          </label>
          <div className="document-form-actions">
            <Button
              type="submit"
              variant="primary"
              disabled={busy || !directory || !validName || !content.trim()}
            >
              预览创建
            </Button>
          </div>
        </Form>
      </Panel>
      {preview && (
        <MutationPreviewDialog
          open
          title="创建文档预览"
          description="确认目标路径和完整 Markdown 差异后才会写入。"
          preview={preview}
          busy={busy}
          onOpenChange={(open) => !open && setPreview(null)}
          onConfirm={() => void commit()}
        />
      )}
    </div>
  );
}
