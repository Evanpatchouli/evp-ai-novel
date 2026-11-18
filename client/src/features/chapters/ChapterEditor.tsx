import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@ldkj/web-ui";
import { countChapterWords } from "../../../../shared/chapter-text";
import { Textarea } from "../../components/Textarea";

export { countChapterWords } from "../../../../shared/chapter-text";

export interface ChapterEditorProps {
  /** 是否允许当前可见编辑器触发保存预览；默认启用以兼容章节创建页。 */
  active?: boolean;
  baselineContent: string;
  /** 保存成功后换用新哈希，编辑器才会重置草稿基线。 */
  baselineVersion: string;
  path: string;
  previewBusy?: boolean;
  previewDisabled?: boolean;
  autoFocus?: boolean;
  onDraftChange?(content: string): void;
  onDirtyChange?(dirty: boolean): void;
  onPreview(content: string): void;
}

export function ChapterEditor({
  active = true,
  baselineContent,
  baselineVersion,
  path,
  previewBusy = false,
  previewDisabled = false,
  autoFocus = false,
  onDraftChange,
  onDirtyChange,
  onPreview,
}: ChapterEditorProps) {
  const [baseline, setBaseline] = useState(baselineContent);
  const [draft, setDraft] = useState(baselineContent);
  const draftRef = useRef(draft);
  const dirty = draft !== baseline;
  draftRef.current = draft;

  useEffect(() => {
    setBaseline(baselineContent);
    setDraft(baselineContent);
  }, [baselineContent, baselineVersion]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const requestPreview = useCallback(() => {
    if (
      !active ||
      previewBusy ||
      previewDisabled ||
      draftRef.current === baseline
    )
      return;
    onPreview(draftRef.current);
  }, [active, baseline, onPreview, previewBusy, previewDisabled]);

  useEffect(() => {
    if (!active) return;
    const handleSaveShortcut = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== "s" ||
        (!event.ctrlKey && !event.metaKey) ||
        event.altKey
      ) {
        return;
      }
      event.preventDefault();
      requestPreview();
    };
    window.addEventListener("keydown", handleSaveShortcut);
    return () => window.removeEventListener("keydown", handleSaveShortcut);
  }, [active, requestPreview]);

  const lineCount = draft.length ? draft.split(/\r?\n/).length : 0;
  const wordCount = countChapterWords(draft);
  const helpId = "chapter-editor-help";

  return (
    <section className="chapter-editor" aria-labelledby="chapter-editor-title">
      <div className="chapter-editor-header">
        <div>
          <h2 id="chapter-editor-title">编辑 Markdown 原文</h2>
          <p id={helpId}>Ctrl/Cmd+S 打开保存预览；Tab 键用于移动焦点。</p>
        </div>
        <span aria-live="polite">{dirty ? "有未保存修改" : "已保存"}</span>
      </div>

      <Textarea
        aria-label="章节 Markdown 原文"
        aria-describedby={helpId}
        autoFocus={autoFocus}
        spellCheck
        value={draft}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          onDraftChange?.(next);
        }}
      />

      <div className="chapter-editor-footer">
        <dl>
          <div>
            <dt>字数</dt>
            <dd>{wordCount.toLocaleString()}</dd>
          </div>
          <div>
            <dt>行数</dt>
            <dd>{lineCount.toLocaleString()}</dd>
          </div>
          <div>
            <dt>文件</dt>
            <dd>{path}</dd>
          </div>
        </dl>
        <Button
          type="button"
          variant="primary"
          disabled={!active || !dirty || previewBusy || previewDisabled}
          aria-busy={previewBusy || undefined}
          onClick={requestPreview}
        >
          预览保存
        </Button>
      </div>
    </section>
  );
}
