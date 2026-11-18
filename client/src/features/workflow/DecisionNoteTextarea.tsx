import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
} from "react";
import { throttle } from "es-toolkit/function";
import { Textarea } from "../../components/Textarea";

const DEFAULT_THROTTLE_MS = 200;

type Props = Omit<
  ComponentPropsWithoutRef<typeof Textarea>,
  "defaultValue" | "onChange" | "value"
> & {
  value: string;
  onValueChange: (value: string) => void;
  throttleMs?: number;
};

/**
 * 备注在本地即时更新，仅按固定间隔把最新文本同步给工作流状态。
 * 失焦和卸载都会先发送尚未同步的最终值。
 */
export const DecisionNoteTextarea = memo(function DecisionNoteTextarea({
  value,
  onValueChange,
  throttleMs = DEFAULT_THROTTLE_MS,
  onBlur,
  ...props
}: Props) {
  const [draft, setDraft] = useState(value);
  const draftRef = useRef(value);
  const lastSentRef = useRef(value);
  const onValueChangeRef = useRef(onValueChange);
  onValueChangeRef.current = onValueChange;

  const throttledSync = useMemo(
    () =>
      throttle(
        (next: string) => {
          lastSentRef.current = next;
          onValueChangeRef.current(next);
        },
        throttleMs,
        { edges: ["leading", "trailing"] },
      ),
    [throttleMs],
  );

  const flushLatest = useCallback(() => {
    throttledSync.flush();
    if (lastSentRef.current !== draftRef.current) {
      lastSentRef.current = draftRef.current;
      onValueChangeRef.current(draftRef.current);
    }
  }, [throttledSync]);

  useEffect(() => {
    if (value === draftRef.current || value === lastSentRef.current) return;
    throttledSync.cancel();
    draftRef.current = value;
    lastSentRef.current = value;
    setDraft(value);
  }, [throttledSync, value]);

  useEffect(
    () => () => {
      flushLatest();
      throttledSync.cancel();
    },
    [flushLatest, throttledSync],
  );

  return (
    <Textarea
      {...props}
      value={draft}
      onChange={(event) => {
        const next = event.target.value;
        draftRef.current = next;
        setDraft(next);
        throttledSync(next);
      }}
      onBlur={(event) => {
        flushLatest();
        onBlur?.(event);
      }}
    />
  );
});
