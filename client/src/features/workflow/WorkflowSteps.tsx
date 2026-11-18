import type { PropsWithChildren } from "react";
import { Alert, Button, Checkbox, Chip } from "@ldkj/web-ui";
import type { FinalConfirmation } from "../../../../shared/contracts";
import { api, type TaskDetail } from "../../api";
import type { ShowNotice } from "../../app/types";
import { AsyncButton } from "../../components/AsyncButton";
import { CopyButton } from "../../components/CopyButton";
import { Panel } from "../../components/layout";
import { EmptyState } from "../../components/states";
import { authorityLabel } from "../../domain/authority";
import { DiffView } from "./DiffView";
import { ReviewIssueList } from "./ReviewIssueList";
import { TextImport } from "./TextImport";
import type { WorkflowController } from "./useWorkflowController";
import { STYLE_REFINEMENT_INSTRUCTION } from "./workflowState";

const CONFIRMATIONS: Record<keyof FinalConfirmation, string> = {
  fullyRead: "我已完整通读修订稿",
  plotAndCharacterApproved: "情节和人物符合我的意图",
  noUnauthorizedCanon: "没有擅自新增设定",
  continuityApproved: "与前后章衔接成立",
  willingToFinalize: "我愿意将这一版确认为终稿",
};

const CONTEXT_PACKAGE_FILENAME = "02_ChatGPT审查上下文.zip";

function contextPackagePath(directory: string): string {
  return `${directory.replace(/[\\/]+$/, "")}/${CONTEXT_PACKAGE_FILENAME}`;
}

function WarningList({ title, items }: { title: string; items: string[] }) {
  return items.length ? (
    <div className="warning-list">
      <strong>{title}</strong>
      <ul>
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </div>
  ) : null;
}

function StepActionBar({
  status,
  sticky = false,
  children,
}: PropsWithChildren<{ status: string; sticky?: boolean }>) {
  return (
    <div
      className={`workflow-step-actions${sticky ? " workflow-step-actions-sticky" : ""}`}
    >
      <span>{status}</span>
      <div>{children}</div>
    </div>
  );
}

export function WorkflowSteps({
  task,
  controller,
  notify,
}: {
  task: TaskDetail;
  controller: WorkflowController;
  notify: ShowNotice;
}) {
  const { state, busy } = controller;
  const allConfirmed = Object.values(state.confirmation).every(Boolean);
  const resolvedDecisionCount = state.issues.filter(
    (issue) => issue.decision && issue.decision !== "later",
  ).length;
  const nextPendingIssueIndex = state.issues.findIndex(
    (issue) => !issue.decision || issue.decision === "later",
  );
  const packagePath = contextPackagePath(task.directory);
  const openPackageFolder = () => {
    void api.open(packagePath, "folder").catch((cause) =>
      notify({
        tone: "error",
        message:
          cause instanceof Error ? cause.message : "无法打开任务包所在文件夹",
      }),
    );
  };

  const focusNextPendingIssue = () => {
    if (nextPendingIssueIndex < 0) return;
    const target = document.getElementById(
      `review-issue-${nextPendingIssueIndex}`,
    );
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
    target?.focus({ preventScroll: true });
  };

  const revisionAnalysis = task.revisionAnalysis;
  const revisionAnalysisPanel = revisionAnalysis ? (
    <Panel
      title="修订差异与风险"
      description={`新增 ${Math.round(revisionAnalysis.addedRatio * 100)}% · 删除 ${Math.round(revisionAnalysis.removedRatio * 100)}%`}
    >
      {(revisionAnalysis.largeUnapprovedRewrite ||
        revisionAnalysis.titleChanged) && (
        <Alert
          variant="warning"
          showIcon
          title="需要重点复核"
          description={[
            revisionAnalysis.largeUnapprovedRewrite && "存在未批准的大段改写",
            revisionAnalysis.titleChanged && "章节标题发生变化",
          ]
            .filter(Boolean)
            .join("；")}
        />
      )}
      <DiffView changes={revisionAnalysis.changes} />
      <WarningList
        title="疑似新增设定"
        items={revisionAnalysis.possibleNewCanon}
      />
      <WarningList
        title="连续性提醒"
        items={revisionAnalysis.continuityWarnings}
      />
    </Panel>
  ) : null;

  const content = (() => {
    switch (task.stage) {
      case "created":
        return (
          <Panel
            title="准备 ChatGPT 审查任务包"
            description="正文与圣经优先；规划、素材与归档会显示内容等级。"
            action={
              <AsyncButton
                size="sm"
                variant="outline"
                busy={busy === "context"}
                onClick={controller.loadContext}
              >
                读取候选资料
              </AsyncButton>
            }
          >
            {state.context.length ? (
              <div className="context-list">
                {state.context.map((item, index) => (
                  <label
                    key={item.path}
                    className="context-item"
                    data-testid="context-candidate"
                  >
                    <Checkbox
                      data-testid={`context-checkbox-${index}`}
                      aria-label={`选择上下文：${item.label}`}
                      checked={item.selected}
                      onCheckedChange={(checked: boolean | "indeterminate") =>
                        controller.toggleContext(index, checked === true)
                      }
                    />
                    <span>
                      <strong>{item.label}</strong>
                      <small>{item.path}</small>
                      <p>{item.reason}</p>
                      {item.warning && <em>{item.warning}</em>}
                    </span>
                    <Chip
                      size="sm"
                      variant={
                        item.authority === "canonical" ||
                        item.authority === "bible"
                          ? "success"
                          : item.authority === "archive"
                            ? "danger"
                            : "default"
                      }
                    >
                      {authorityLabel(item.authority)}
                    </Chip>
                  </label>
                ))}
              </div>
            ) : (
              <EmptyState
                label="尚未读取候选资料"
                detail="系统会根据当前章、前后章和连续性资料给出建议。"
              />
            )}
            <AsyncButton
              variant="primary"
              busy={busy === "build"}
              disabled={!state.context.some((item) => item.selected)}
              onClick={controller.buildContext}
            >
              生成任务包与提示词
            </AsyncButton>
          </Panel>
        );
      case "context-ready":
        return (
          <div className="workflow-handoff-grid">
            <Panel
              className="workflow-handoff-panel"
              title="审查提示词"
              description="复制到 ChatGPT Web；此步骤只要求审查，不改写正文。"
              action={<CopyButton text={state.prompt} notify={notify} />}
            >
              <div className="workflow-package-handoff">
                <div className="workflow-package-handoff-copy">
                  <strong>ChatGPT 审查任务包已生成</strong>
                </div>
                <div className="inline-actions">
                  <Button
                    data-testid="context-package-download"
                    component="a"
                    size="sm"
                    variant="primary"
                    href={api.contextPackageDownloadUrl(task.id)}
                    download
                  >
                    下载任务包
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={openPackageFolder}
                  >
                    打开文件夹
                  </Button>
                </div>
              </div>
              <pre className="prompt-preview">{state.prompt}</pre>
            </Panel>
            <Panel
              className="workflow-handoff-panel"
              title="导入审稿报告"
              description="可粘贴或读取本地文本文件；原始输出会完整保存。"
            >
              <TextImport
                value={state.reviewText}
                onChange={controller.setReviewText}
                label="ChatGPT 审稿报告"
              />
              <StepActionBar
                status={
                  state.reviewText.trim()
                    ? "审稿报告已载入"
                    : "等待粘贴审稿报告"
                }
              >
                <AsyncButton
                  variant="primary"
                  busy={busy === "review"}
                  disabled={!state.reviewText.trim()}
                  onClick={controller.importReview}
                >
                  保存并解析报告
                </AsyncButton>
              </StepActionBar>
            </Panel>
          </div>
        );
      case "review-imported":
        return (
          <Panel
            title="逐条作出人工决策"
            description="只有批准或部分批准的问题会进入修订要求。"
          >
            <label className="decision-instruction-option">
              <Checkbox
                data-testid="style-refinement-checkbox"
                aria-label={STYLE_REFINEMENT_INSTRUCTION}
                checked={state.revisionInstructionAdditions.includes(
                  STYLE_REFINEMENT_INSTRUCTION,
                )}
                onCheckedChange={(checked: boolean | "indeterminate") =>
                  controller.toggleRevisionInstruction(checked === true)
                }
              />
              <span>{STYLE_REFINEMENT_INSTRUCTION}</span>
            </label>
            <StepActionBar
              status={`已处理 ${resolvedDecisionCount} / ${state.issues.length}`}
              sticky
            >
              <Button
                type="button"
                variant="outline"
                disabled={!state.issues.length}
                onClick={() => controller.setAllDecisions("approved")}
              >
                全部通过
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={!state.issues.length}
                onClick={() => controller.setAllDecisions("rejected")}
              >
                全部拒绝
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={nextPendingIssueIndex < 0}
                onClick={focusNextPendingIssue}
              >
                下一条未处理
              </Button>
              <AsyncButton
                variant="primary"
                busy={busy === "decisions"}
                onClick={controller.saveDecisions}
              >
                记录人工决策
              </AsyncButton>
            </StepActionBar>
            <ReviewIssueList
              issues={state.issues}
              updateIssue={controller.updateIssue}
            />
          </Panel>
        );
      case "decisions-recorded":
        return (
          <div className="workflow-handoff-grid">
            <Panel
              className="workflow-handoff-panel"
              title="修订提示词"
              description="复制到 ChatGPT Web；只按已批准的要求生成完整修订稿。"
              action={<CopyButton text={state.prompt} notify={notify} />}
            >
              <pre className="prompt-preview">{state.prompt}</pre>
              <div className="workflow-package-actions">
                <AsyncButton
                  variant="primary"
                  busy={busy === "compact-revision-package"}
                  onClick={controller.buildCompactRevisionPackage}
                >
                  生成精简修订包（推荐）
                </AsyncButton>
                <AsyncButton
                  variant="outline"
                  busy={busy === "compact-text-revision-package"}
                  onClick={controller.buildCompactTextRevisionPackage}
                >
                  生成单文件包（DeepSeek 等）
                </AsyncButton>
                <AsyncButton
                  variant="outline"
                  busy={busy === "revision-package"}
                  onClick={controller.buildRevisionPackage}
                >
                  生成完整审计包
                </AsyncButton>
                <small className="muted">
                  支持 ZIP 时优先使用精简包；DeepSeek 等不支持 ZIP
                  的平台使用单文件包。完整审计包仅用于追溯和复杂复核。
                </small>
              </div>
            </Panel>
            <Panel
              className="workflow-handoff-panel"
              title="导入完整修订稿"
              description="系统将与任务输入快照比较，并标记异常改写和疑似新增设定。"
            >
              <TextImport
                value={state.revisionText}
                onChange={controller.setRevisionText}
                label="完整章节修订稿"
                tall
              />
              <StepActionBar
                status={
                  state.revisionText.trim()
                    ? "完整修订稿已载入"
                    : "等待粘贴完整修订稿"
                }
              >
                <AsyncButton
                  variant="primary"
                  busy={busy === "revision"}
                  disabled={!state.revisionText.trim()}
                  onClick={controller.importRevision}
                >
                  保存并分析差异
                </AsyncButton>
              </StepActionBar>
            </Panel>
          </div>
        );
      case "revision-imported":
        return (
          <>
            {revisionAnalysisPanel}
            <Panel
              title="人工终审稿"
              description="依据差异与风险逐字终审；保存后再进入五项写入确认。"
            >
              <StepActionBar status="人工终审稿已载入" sticky>
                <AsyncButton
                  variant="primary"
                  busy={busy === "human-final"}
                  disabled={!state.revisionText.trim()}
                  onClick={controller.saveHumanFinal}
                >
                  保存人工终审稿
                </AsyncButton>
              </StepActionBar>
              <TextImport
                value={state.revisionText}
                onChange={controller.setRevisionText}
                label="人工终审稿"
                tall
              />
            </Panel>
          </>
        );
      case "human-final-review":
        return (
          <Panel
            title="终稿写入确认"
            description="五项全部由作者确认后，才可进入正式写入预览。"
          >
            <div className="confirmation-list">
              {Object.entries(CONFIRMATIONS).map(([key, label]) => (
                <label key={key}>
                  <Checkbox
                    checked={state.confirmation[key as keyof FinalConfirmation]}
                    onCheckedChange={(checked: boolean | "indeterminate") =>
                      controller.confirm(
                        key as keyof FinalConfirmation,
                        checked === true,
                      )
                    }
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
            <StepActionBar
              status={allConfirmed ? "五项已全部确认" : "请确认全部五项"}
            >
              <Button
                type="button"
                variant="outline"
                disabled={allConfirmed}
                onClick={controller.confirmAll}
              >
                全选
              </Button>
              <AsyncButton
                variant="primary"
                busy={busy === "confirmation"}
                disabled={!allConfirmed}
                onClick={controller.confirmFinal}
              >
                确认终稿并进入写入
              </AsyncButton>
            </StepActionBar>
          </Panel>
        );
      case "ready-to-write":
        return (
          <Panel
            title="正式写入预览"
            description="核对差异后，再执行唯一会改动正式正文的操作。"
          >
            {state.preview ? (
              <>
                <dl className="write-paths">
                  <div>
                    <dt>正文目标</dt>
                    <dd>{state.preview.targetPath}</dd>
                  </div>
                  <div>
                    <dt>状态表</dt>
                    <dd>{state.preview.statusPath}</dd>
                  </div>
                  <div>
                    <dt>预览有效期</dt>
                    <dd>
                      {new Date(state.preview.expiresAt).toLocaleString(
                        "zh-CN",
                      )}
                    </dd>
                  </div>
                </dl>
                <DiffView changes={state.preview.diff} />
                <div className="write-commit-actions">
                  <Alert
                    variant="warning"
                    showIcon
                    title="这是唯一会修改正式正文的操作"
                    description="写入会验证预览时的文件哈希，并以原子方式同步正文、状态表与生产记录。"
                  />
                  <AsyncButton
                    variant="primary"
                    busy={busy === "write"}
                    onClick={controller.write}
                  >
                    我已核对，确认写入终稿
                  </AsyncButton>
                </div>
              </>
            ) : (
              <div className="workflow-action-prompt">
                <div className="workflow-action-prompt-copy">
                  <span>写入前检查</span>
                  <strong>先生成只读预览</strong>
                  <p>系统只会计算文件差异并签发短时令牌，不会修改任何文件。</p>
                </div>
                <AsyncButton
                  variant="primary"
                  busy={busy === "preview"}
                  onClick={controller.makePreview}
                >
                  生成写入预览
                </AsyncButton>
              </div>
            )}
          </Panel>
        );
      case "written":
        return (
          <Panel
            title="结束本轮任务"
            description="归档生产工件后，本轮任务将转为只读。"
          >
            <div className="workflow-action-prompt">
              <div className="workflow-action-prompt-copy">
                <span>任务收尾</span>
                <strong>归档本轮生产工件</strong>
                <p>原任务链接仍可只读查看；工作台不会自动创建 Git 提交。</p>
              </div>
              <AsyncButton
                variant="primary"
                busy={busy === "archive"}
                onClick={controller.archive}
              >
                归档生产工件
              </AsyncButton>
            </div>
          </Panel>
        );
      case "archived":
        return (
          <Panel
            title="任务已归档"
            description="本轮生产工件已经归档，任务保持只读。"
          />
        );
    }
  })();

  return <div className="workflow-main">{content}</div>;
}
