import { useRef, useState } from "react";
import { Button } from "@ldkj/web-ui";
import type { TextChange } from "../../../../shared/contracts";
import { EmptyState } from "../../components/states";

const CONTEXT_EDGE_LENGTH = 90;

function focusedValue(change: TextChange) {
  if (
    change.type !== "unchanged" ||
    change.value.length <= CONTEXT_EDGE_LENGTH * 2
  )
    return change.value;
  const hiddenLength = change.value.length - CONTEXT_EDGE_LENGTH * 2;
  return `${change.value.slice(0, CONTEXT_EDGE_LENGTH)}\n\n… 已折叠 ${hiddenLength} 字未改正文 …\n\n${change.value.slice(-CONTEXT_EDGE_LENGTH)}`;
}

export function DiffView({ changes }: { changes: TextChange[] }) {
  const [mode, setMode] = useState<"focused" | "full">("focused");
  const [activeChange, setActiveChange] = useState(-1);
  const changeRefs = useRef<Array<HTMLSpanElement | null>>([]);
  if (!changes.length) return <EmptyState label="暂无差异" />;

  const changedLookup = new Map<number, number>();
  for (const [sourceIndex, change] of changes.entries()) {
    if (change.type !== "unchanged")
      changedLookup.set(sourceIndex, changedLookup.size);
  }

  const navigateChange = (direction: -1 | 1) => {
    const count = changedLookup.size;
    if (!count) return;
    const next =
      activeChange < 0
        ? direction > 0
          ? 0
          : count - 1
        : (activeChange + direction + count) % count;
    setActiveChange(next);
    changeRefs.current[next]?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  };

  return (
    <div className="diff-shell">
      <div className="diff-toolbar">
        <div className="diff-mode-actions" aria-label="差异显示方式">
          <Button
            type="button"
            size="sm"
            variant="text"
            className={mode === "focused" ? "active" : ""}
            aria-pressed={mode === "focused"}
            onClick={() => setMode("focused")}
          >
            仅看改动
          </Button>
          <Button
            type="button"
            size="sm"
            variant="text"
            className={mode === "full" ? "active" : ""}
            aria-pressed={mode === "full"}
            onClick={() => setMode("full")}
          >
            完整上下文
          </Button>
        </div>
        <div className="diff-navigation">
          <span>{changedLookup.size} 处改动</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!changedLookup.size}
            aria-label="上一处改动"
            onClick={() => navigateChange(-1)}
          >
            上一处
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!changedLookup.size}
            aria-label="下一处改动"
            onClick={() => navigateChange(1)}
          >
            下一处
          </Button>
        </div>
      </div>
      <pre className="diff-view" aria-label="正文文本差异">
        {changes.map((change, sourceIndex) => {
          const changeIndex = changedLookup.get(sourceIndex);
          return (
            <span
              key={sourceIndex}
              className={`diff-${change.type}`}
              data-active={
                changeIndex !== undefined && changeIndex === activeChange
                  ? "true"
                  : undefined
              }
              ref={
                changeIndex === undefined
                  ? undefined
                  : (element) => {
                      changeRefs.current[changeIndex] = element;
                    }
              }
            >
              {mode === "focused" ? focusedValue(change) : change.value}
            </span>
          );
        })}
      </pre>
    </div>
  );
}
