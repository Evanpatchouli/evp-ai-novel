import { useId, useRef, useState, type ReactNode } from "react";
import {
  Alert,
  Button,
  Icon,
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@ldkj/web-ui";
import { AsyncButton } from "./AsyncButton";

interface DeleteConfirmationProps {
  trigger: ReactNode;
  triggerLabel?: string;
  triggerClassName?: string;
  title: string;
  description: ReactNode;
  disabled?: boolean;
  onConfirm(): void | Promise<void>;
  onOpenChange?(open: boolean): void;
}

export function DeleteConfirmation({
  trigger,
  triggerLabel,
  triggerClassName,
  title,
  description,
  disabled,
  onConfirm,
  onOpenChange,
}: DeleteConfirmationProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const anchor = useRef<HTMLSpanElement>(null);
  const cancel = useRef<HTMLSpanElement>(null);
  const id = useId();

  const changeOpen = (next: boolean) => {
    if (busy) return;
    if (next) setError("");
    setOpen(next);
    onOpenChange?.(next);
  };

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onConfirm();
      setOpen(false);
      onOpenChange?.(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "删除失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverAnchor asChild>
        <span ref={anchor} className="delete-confirm-anchor">
          <Button
            type="button"
            variant={triggerLabel ? "ghost" : "danger"}
            size={triggerLabel ? "icon" : "md"}
            className={triggerClassName}
            aria-label={triggerLabel}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={open ? id : undefined}
            disabled={disabled || busy}
            onClick={() => changeOpen(!open)}
          >
            {trigger}
          </Button>
        </span>
      </PopoverAnchor>
      <PopoverContent
        id={id}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        side="top"
        align="end"
        sideOffset={9}
        collisionPadding={12}
        width="min(18rem, calc(100vw - 24px))"
        className="delete-confirm-popover"
        onOpenAutoFocus={(event: Event) => {
          event.preventDefault();
          cancel.current?.querySelector("button")?.focus();
        }}
        onCloseAutoFocus={(event: Event) => {
          event.preventDefault();
          anchor.current
            ?.querySelector("button")
            ?.focus({ preventScroll: true });
        }}
        onEscapeKeyDown={(event: KeyboardEvent) => {
          if (busy) event.preventDefault();
        }}
        onInteractOutside={(event: Event) => {
          if (
            busy ||
            (event.target instanceof Node &&
              anchor.current?.contains(event.target))
          )
            event.preventDefault();
        }}
      >
        <div className="delete-confirm-header">
          <Icon name="error" size={18} />
          <strong id={`${id}-title`}>{title}</strong>
          <p id={`${id}-description`}>{description}</p>
        </div>
        {error && <Alert variant="error" title={error} />}
        <div className="delete-confirm-actions">
          <span ref={cancel}>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => changeOpen(false)}
            >
              取消
            </Button>
          </span>
          <AsyncButton
            type="button"
            size="sm"
            variant="danger"
            busy={busy}
            onClick={() => void confirm()}
          >
            永久删除
          </AsyncButton>
        </div>
      </PopoverContent>
    </Popover>
  );
}
