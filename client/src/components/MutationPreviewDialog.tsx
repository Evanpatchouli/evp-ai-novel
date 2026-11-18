import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Button, Checkbox, Dialog } from "@ldkj/web-ui";
import type { TextChange } from "../../../shared/contracts";
import { DiffView } from "../features/workflow/DiffView";
import { AsyncButton } from "./AsyncButton";
import { DeleteConfirmation } from "./DeleteConfirmation";
import { ScrollArea } from "./ScrollArea";

export interface MutationPreviewReferenceImpact {
  path: string;
  severity: "blocking" | "warning";
  evidence: string;
}

export interface MutationPreviewDialogData {
  targetPath: string;
  diff: TextChange[];
  beforeWordCount?: number;
  afterWordCount?: number;
  expiresAt?: string;
  plannedChanges?: string[];
  referenceImpacts?: MutationPreviewReferenceImpact[];
  confirmationRequirements?: string[];
}

export interface MutationPreviewDialogProps {
  open: boolean;
  title: string;
  description?: string;
  preview: MutationPreviewDialogData;
  busy?: boolean;
  confirmLabel?: string;
  confirmDisabled?: boolean;
  confirmDeletion?: boolean;
  diffTitle?: string;
  confirmationLabels?: Record<string, string>;
  children?: ReactNode;
  onOpenChange(open: boolean): void;
  onConfirm(): void | Promise<void>;
}

/** 统一展示章节创建、编辑、归档与恢复的完整变更预览。 */
export function MutationPreviewDialog({
  open,
  title,
  description,
  preview,
  busy = false,
  confirmLabel = "确认写入",
  confirmDisabled = false,
  confirmDeletion = false,
  diffTitle = "Markdown 完整差异",
  confirmationLabels = {},
  children,
  onOpenChange,
  onConfirm,
}: MutationPreviewDialogProps) {
  const impacts = preview.referenceImpacts ?? [];
  const plannedChanges = preview.plannedChanges ?? [];
  const requirements = preview.confirmationRequirements ?? [];
  const confirmationIdPrefix = useId();
  const [confirmedKeys, setConfirmedKeys] = useState<string[]>([]);
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);
  useEffect(() => setConfirmedKeys([]), [open, preview]);
  const hasBlockingImpact = impacts.some(
    (impact) => impact.severity === "blocking",
  );
  const allConfirmed = useMemo(
    () => requirements.every((key) => confirmedKeys.includes(key)),
    [confirmedKeys, requirements],
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busy) onOpenChange(nextOpen);
      }}
      closeOnMaskClick={!busy}
      scrollable
    >
      <Dialog.Content
        className="mutation-preview-dialog-content"
        showClose={!busy}
        onEscapeKeyDown={(event) => {
          if (deleteConfirmationOpen) event.preventDefault();
        }}
      >
        <Dialog.Header>
          <Dialog.Title>{title}</Dialog.Title>
          {description && (
            <Dialog.Description>{description}</Dialog.Description>
          )}
        </Dialog.Header>

        <dl className="write-paths">
          <div>
            <dt>目标路径</dt>
            <dd>{preview.targetPath}</dd>
          </div>
          {preview.beforeWordCount !== undefined &&
            preview.afterWordCount !== undefined && (
              <div>
                <dt>正文字数</dt>
                <dd>
                  {preview.beforeWordCount.toLocaleString()} →{" "}
                  {preview.afterWordCount.toLocaleString()} 字
                </dd>
              </div>
            )}
          {preview.expiresAt && (
            <div>
              <dt>预览有效期</dt>
              <dd>{new Date(preview.expiresAt).toLocaleString("zh-CN")}</dd>
            </div>
          )}
        </dl>

        {plannedChanges.length > 0 && (
          <section aria-labelledby="planned-change-title">
            <h3 id="planned-change-title">计划变更</h3>
            <ul>
              {plannedChanges.map((change) => (
                <li key={change}>{change}</li>
              ))}
            </ul>
          </section>
        )}

        <section aria-labelledby="mutation-diff-title">
          <h3 id="mutation-diff-title">{diffTitle}</h3>
          <ScrollArea maxHeight="45vh" aria-label={diffTitle}>
            <DiffView changes={preview.diff} />
          </ScrollArea>
        </section>

        {impacts.length > 0 && (
          <section aria-labelledby="reference-impact-title">
            <h3 id="reference-impact-title">引用影响</h3>
            <ul>
              {impacts.map((impact, index) => (
                <li key={`${impact.path}-${index}`}>
                  <strong>
                    {impact.severity === "blocking" ? "阻断" : "警告"}
                  </strong>{" "}
                  <span>{impact.path}</span>
                  <p>{impact.evidence}</p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {requirements.length > 0 && (
          <section aria-labelledby="mutation-confirmation-title">
            <h3 id="mutation-confirmation-title">明确确认</h3>
            <div className="mutation-confirmations">
              {requirements.map((key, index) => {
                const checkboxId = `${confirmationIdPrefix}-checkbox-${index}`;
                const labelId = `${confirmationIdPrefix}-label-${index}`;
                return (
                  <label
                    className="mutation-confirmation-option"
                    htmlFor={checkboxId}
                    key={key}
                  >
                    <Checkbox
                      id={checkboxId}
                      aria-labelledby={labelId}
                      checked={confirmedKeys.includes(key)}
                      onCheckedChange={(checked: boolean | "indeterminate") =>
                        setConfirmedKeys((current) =>
                          checked
                            ? [...new Set([...current, key])]
                            : current.filter((item) => item !== key),
                        )
                      }
                    />
                    <span id={labelId}>
                      {confirmationLabels[key] ??
                        confirmationRequirementLabel(key)}
                    </span>
                  </label>
                );
              })}
            </div>
          </section>
        )}

        {children}

        <Dialog.Footer>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          {confirmDeletion ? (
            <DeleteConfirmation
              trigger={confirmLabel}
              title="确认永久删除？"
              description="预览中的文件将从工作区移除，无法从工作台回收站恢复。"
              disabled={
                busy || confirmDisabled || hasBlockingImpact || !allConfirmed
              }
              onOpenChange={setDeleteConfirmationOpen}
              onConfirm={onConfirm}
            />
          ) : (
            <AsyncButton
              type="button"
              variant="primary"
              busy={busy}
              disabled={confirmDisabled || hasBlockingImpact || !allConfirmed}
              onClick={onConfirm}
            >
              {confirmLabel}
            </AsyncButton>
          )}
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog>
  );
}

function confirmationRequirementLabel(key: string): string {
  const labels: Record<string, string> = {
    "confirm-volume-create": "我确认创建这一卷及其结构化状态文件。",
    "confirm-volume-rename": "我确认只修改卷名，不改变卷 ID、卷号或物理目录。",
    "confirm-archive": "我确认将资产移入工作台回收站。",
    "confirm-final-archive": "我确认归档范围包含终稿内容。",
    "confirm-reference-impacts": "我已阅读并接受列出的引用影响。",
    "confirm-volume-archive": "我确认归档整卷及其拥有的规划资产。",
    "confirm-volume-delete": "我确认永久删除整卷正文及其拥有的规划资产。",
    "confirm-chapter-delete": "我确认永久删除本章正文并更新卷状态表。",
    "confirm-final-delete": "我确认删除范围包含终稿内容。",
    "confirm-volume-restore": "我确认按原路径恢复这一卷。",
    "confirm-document-create": "我确认在所示权威目录创建这一 Markdown 文档。",
    "confirm-document-edit": "我确认按完整差异修改这一 Markdown 文档。",
    "confirm-document-archive": "我确认将这一文档移入工作台回收站。",
    "confirm-document-restore": "我确认按原路径恢复这一文档。",
    "confirm-novel-metadata-create": "我确认创建可选的小说元数据 YAML。",
    "confirm-novel-metadata-update": "我确认按完整差异修改小说元数据 YAML。",
  };
  return labels[key] ?? `我确认此操作要求：${key}`;
}
