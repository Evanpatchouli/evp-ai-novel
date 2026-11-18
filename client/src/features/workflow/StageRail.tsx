import { useId, useState } from "react";
import { Button, Dialog, Progress } from "@ldkj/web-ui";
import type { TaskStage } from "../../../../shared/contracts";
import { AsyncButton } from "../../components/AsyncButton";

export const STAGE_ORDER: TaskStage[] = [
  "created",
  "context-ready",
  "review-imported",
  "decisions-recorded",
  "revision-imported",
  "human-final-review",
  "ready-to-write",
  "written",
  "archived",
];
const STAGE_LABEL: Record<TaskStage, string> = {
  created: "创建任务",
  "context-ready": "准备上下文",
  "review-imported": "导入审稿",
  "decisions-recorded": "人工决策",
  "revision-imported": "导入修订",
  "human-final-review": "人工终审",
  "ready-to-write": "确认写入",
  written: "写入正文",
  archived: "结束任务",
};

const ACTIVE_STEP_INDEX: Record<TaskStage, number> = {
  created: 1,
  "context-ready": 2,
  "review-imported": 3,
  "decisions-recorded": 4,
  "revision-imported": 5,
  "human-final-review": 6,
  "ready-to-write": 7,
  written: 8,
  archived: 8,
};

const REWIND_TARGET_BY_STEP_INDEX: Partial<Record<number, TaskStage>> = {
  1: "created",
  2: "context-ready",
  3: "review-imported",
  4: "decisions-recorded",
  5: "revision-imported",
  6: "human-final-review",
};

export function StageRail({
  stage,
  busy = false,
  onRewind,
}: {
  stage: TaskStage;
  busy?: boolean;
  onRewind?: (stage: TaskStage) => void;
}) {
  const current = ACTIVE_STEP_INDEX[stage];
  const stageListId = useId();
  const [expanded, setExpanded] = useState(false);
  const [rewindTarget, setRewindTarget] = useState<{
    stage: TaskStage;
    label: string;
  } | null>(null);

  const confirmRewind = () => {
    if (!rewindTarget || busy) return;
    onRewind?.(rewindTarget.stage);
    setRewindTarget(null);
  };

  return (
    <>
      <div
        className="stage-rail"
        aria-label={`当前步骤：${STAGE_LABEL[STAGE_ORDER[current]!]}`}
      >
        <div className="stage-summary">
          <span>
            终稿验收进度
            <small>{STAGE_LABEL[STAGE_ORDER[current]!]}</small>
          </span>
          <strong>{current + 1} / 9</strong>
        </div>
        <Progress
          value={current + 1}
          max={9}
          showInfo={false}
          size="sm"
          strokeColor="#9e3f2d"
        />
        <Button
          type="button"
          size="sm"
          variant="text"
          className="stage-rail-toggle"
          aria-controls={stageListId}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "收起全部步骤" : "查看全部步骤"}
        </Button>
        <ol id={stageListId} className={expanded ? "expanded" : ""}>
          {STAGE_ORDER.map((item, index) => {
            const rewindStage = REWIND_TARGET_BY_STEP_INDEX[index];
            const canRewind =
              Boolean(onRewind) &&
              STAGE_ORDER.indexOf(stage) < STAGE_ORDER.indexOf("written") &&
              index < current &&
              rewindStage !== undefined;
            return (
              <li
                aria-current={index === current ? "step" : undefined}
                className={
                  index === current ? "active" : index < current ? "done" : ""
                }
                key={item}
              >
                {canRewind ? (
                  <Button
                    type="button"
                    variant="text"
                    className="stage-rewind-button"
                    aria-label={`返回${STAGE_LABEL[item]}`}
                    disabled={busy}
                    onClick={() =>
                      setRewindTarget({
                        stage: rewindStage!,
                        label: STAGE_LABEL[item],
                      })
                    }
                  >
                    <span>{index + 1}</span>
                    {STAGE_LABEL[item]}
                  </Button>
                ) : (
                  <div className="stage-static-item">
                    <span>{index + 1}</span>
                    {STAGE_LABEL[item]}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </div>

      <Dialog
        open={rewindTarget !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setRewindTarget(null);
        }}
        closeOnMaskClick={!busy}
      >
        <Dialog.Content showClose={!busy}>
          <Dialog.Header>
            <Dialog.Title>回退到“{rewindTarget?.label ?? ""}”？</Dialog.Title>
            <Dialog.Description>
              旧的审稿及后续产物会移入历史目录，不会被删除；目标阶段之后的当前状态将被清空，且不能通过阶段切换直接向前跳过审核。
            </Dialog.Description>
          </Dialog.Header>
          <Dialog.Footer>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => setRewindTarget(null)}
            >
              取消
            </Button>
            <AsyncButton
              type="button"
              variant="primary"
              busy={busy}
              onClick={confirmRewind}
            >
              确认回退
            </AsyncButton>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>
    </>
  );
}
