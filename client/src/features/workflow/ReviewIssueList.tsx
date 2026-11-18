import { memo, useId } from "react";
import { Chip } from "@ldkj/web-ui";
import type { DecisionStatus, ReviewIssue } from "../../../../shared/contracts";
import { MarkdownContent } from "../../components/MarkdownContent";
import { SelectField } from "../../components/SelectField";
import { EmptyState } from "../../components/states";
import { DecisionNoteTextarea } from "./DecisionNoteTextarea";

const SEVERITY_LABEL = {
  blocker: "阻断",
  important: "重要",
  minor: "轻微",
  optional: "可选",
} as const;

const DECISION_OPTIONS = [
  { value: "approved", label: "批准" },
  { value: "partially-approved", label: "部分批准" },
  { value: "rejected", label: "拒绝" },
  { value: "later", label: "稍后决定" },
];

export function ReviewIssueList({
  issues,
  updateIssue,
}: {
  issues: ReviewIssue[];
  updateIssue: (index: number, patch: Partial<ReviewIssue>) => void;
}) {
  if (!issues.length)
    return (
      <EmptyState
        label="未解析出结构化问题"
        detail="原始报告仍已保留；确认报告确实没有问题后，可以继续生成修订要求。"
      />
    );
  return (
    <div className="issue-list">
      {issues.map((issue, index) => (
        <ReviewIssueCard
          key={issue.id}
          issue={issue}
          index={index}
          total={issues.length}
          updateIssue={updateIssue}
        />
      ))}
    </div>
  );
}

interface ReviewIssueCardProps {
  issue: ReviewIssue;
  index: number;
  total: number;
  updateIssue: (index: number, patch: Partial<ReviewIssue>) => void;
}

/** 隔离单条问题的渲染，未变化的问题对象不会重复解析 Markdown。 */
const ReviewIssueCard = memo(function ReviewIssueCard({
  issue,
  index,
  total,
  updateIssue,
}: ReviewIssueCardProps) {
  const noteId = useId();

  return (
    <article
      id={`review-issue-${index}`}
      className={`issue severity-${issue.severity}`}
      tabIndex={-1}
    >
      <header>
        <div className="issue-meta">
          <Chip
            className={`severity-chip severity-chip-${issue.severity}`}
            size="sm"
            variant={
              issue.severity === "blocker"
                ? "danger"
                : issue.severity === "important"
                  ? "warning"
                  : "default"
            }
          >
            {SEVERITY_LABEL[issue.severity]}
          </Chip>
          <span>
            问题 {index + 1} / {total}
          </span>
        </div>
        <h3>
          <MarkdownContent inline>{issue.title}</MarkdownContent>
        </h3>
      </header>
      <div className="issue-context">
        {issue.evidence && issue.evidence.length > 0 && (
          <section>
            <h4>证据</h4>
            <div className="issue-evidence-list">
              {issue.evidence.map((evidence, evidenceIndex) => (
                <MarkdownContent key={`${issue.id}-evidence-${evidenceIndex}`}>
                  {evidence}
                </MarkdownContent>
              ))}
            </div>
          </section>
        )}
        {issue.impact && (
          <section>
            <h4>影响</h4>
            <MarkdownContent>{issue.impact}</MarkdownContent>
          </section>
        )}
        {issue.suggestion && (
          <section>
            <h4>建议</h4>
            <MarkdownContent>{issue.suggestion}</MarkdownContent>
          </section>
        )}
        {!issue.evidence?.length &&
          !issue.impact &&
          !issue.suggestion &&
          issue.detail && (
            <MarkdownContent className="issue-legacy-detail">
              {issue.detail}
            </MarkdownContent>
          )}
      </div>
      <div className="decision-row">
        <SelectField
          label="处理决定"
          value={issue.decision ?? "later"}
          options={DECISION_OPTIONS}
          onValueChange={(decision) =>
            updateIssue(index, {
              decision: decision as DecisionStatus,
            })
          }
          className="decision-select"
        />
        <label className="decision-note-field" htmlFor={noteId}>
          <span className="decision-field-label">决策备注</span>
          <DecisionNoteTextarea
            id={noteId}
            aria-label={`${issue.title}的决策备注`}
            value={issue.decisionNote ?? ""}
            onValueChange={(decisionNote) =>
              updateIssue(index, { decisionNote })
            }
            rows={2}
            placeholder="部分批准时，请说明批准范围或处理约束"
          />
        </label>
      </div>
    </article>
  );
});
