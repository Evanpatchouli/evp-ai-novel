import { useRef, useState } from "react";
import {
  Button,
  Icon,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipTrigger,
} from "@ldkj/web-ui";
import type { ManagedNovel } from "../api";
import { DeleteConfirmation } from "../components/DeleteConfirmation";

interface NovelPickerProps {
  novels: ManagedNovel[];
  selectedId: string;
  disabled: boolean;
  hasUnsavedChanges: boolean;
  onSelect(id: string): void;
  onDelete(novel: ManagedNovel): Promise<void>;
}

export function NovelPicker({
  novels,
  selectedId,
  disabled,
  hasUnsavedChanges,
  onSelect,
  onDelete,
}: NovelPickerProps) {
  const [open, setOpen] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const selected = novels.find((novel) => novel.id === selectedId);

  return (
    <Popover
      open={open && !disabled && novels.length > 0}
      onOpenChange={setOpen}
    >
      <PopoverTrigger
        type="button"
        className="novel-picker-trigger"
        aria-label={selected ? `当前小说：${selected.title}` : "当前小说"}
        disabled={disabled || novels.length === 0}
      >
        <span>{selected?.title ?? "选择小说"}</span>
        <span className="novel-picker-chevron" aria-hidden="true">
          <Icon name="chevron_right" size={18} />
        </span>
      </PopoverTrigger>
      <PopoverContent
        ref={content}
        align="start"
        side="bottom"
        sideOffset={8}
        collisionPadding={12}
        width="min(22rem, calc(100vw - 24px))"
        className="novel-picker-panel"
        aria-label="选择小说"
        tabIndex={-1}
        onOpenAutoFocus={(event: Event) => {
          event.preventDefault();
          content.current?.focus({ preventScroll: true });
        }}
      >
        <TooltipProvider delayDuration={380}>
          <ul className="novel-picker-list" role="list">
            {novels.map((novel) => (
              <li
                key={novel.id}
                className="novel-picker-row"
                data-selected={novel.id === selectedId || undefined}
              >
                <NovelOption
                  title={novel.title}
                  selected={novel.id === selectedId}
                  onSelect={() => {
                    setOpen(false);
                    onSelect(novel.id);
                  }}
                />
                <DeleteConfirmation
                  trigger={<Icon name="delete" size={18} />}
                  triggerLabel={`删除小说：${novel.title}`}
                  triggerClassName="novel-picker-delete"
                  title="永久删除小说？"
                  description={
                    <>
                      《{novel.title}》的文件、Git
                      历史和归档将被永久删除。此操作无法撤销。
                      {novel.id === selectedId &&
                        hasUnsavedChanges &&
                        "当前未保存的修改也会丢失。"}
                    </>
                  }
                  onConfirm={async () => {
                    await onDelete(novel);
                    if (novel.id === selectedId) setOpen(false);
                  }}
                />
              </li>
            ))}
          </ul>
        </TooltipProvider>
      </PopoverContent>
    </Popover>
  );
}

function NovelOption({
  title,
  selected,
  onSelect,
}: {
  title: string;
  selected: boolean;
  onSelect(): void;
}) {
  const label = useRef<HTMLSpanElement>(null);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  return (
    <Tooltip
      open={tooltipOpen}
      onOpenChange={(next: boolean) => {
        const name = label.current;
        setTooltipOpen(
          next && Boolean(name && name.scrollWidth > name.clientWidth),
        );
      }}
    >
      <TooltipTrigger asChild className="novel-picker-option-trigger">
        <Button
          type="button"
          variant="text"
          className="novel-picker-option"
          aria-pressed={selected}
          onClick={onSelect}
        >
          <span ref={label}>{title}</span>
        </Button>
      </TooltipTrigger>
      <TooltipPortal>
        <TooltipContent
          className="novel-picker-tooltip"
          side="top"
          collisionPadding={12}
        >
          {title}
        </TooltipContent>
      </TooltipPortal>
    </Tooltip>
  );
}
