/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChapterEditor,
  countChapterWords,
} from "../../client/src/features/chapters/ChapterEditor.js";

afterEach(cleanup);

describe("ChapterEditor", () => {
  it("使用本地草稿立即输入，精确报告 dirty并在回到基线时清除", async () => {
    const user = userEvent.setup();
    const onDirtyChange = vi.fn();
    render(
      <ChapterEditor
        baselineContent={"# 第一章\n\n原文"}
        baselineVersion="hash-1"
        path="40_正文/卷/v01/章节/ch001.md"
        onDirtyChange={onDirtyChange}
        onPreview={vi.fn()}
      />,
    );
    const editor = screen.getByRole("textbox", { name: "章节 Markdown 原文" });

    await user.clear(editor);
    await user.type(editor, "# 第一章\n\n新文");
    expect((editor as HTMLTextAreaElement).value).toBe("# 第一章\n\n新文");
    expect(screen.getByText("有未保存修改")).toBeTruthy();
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    fireEvent.change(editor, { target: { value: "# 第一章\n\n原文" } });
    expect(screen.getByText("已保存")).toBeTruthy();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("Ctrl/Cmd+S 只请求当前草稿的保存预览", () => {
    const onPreview = vi.fn();
    render(
      <ChapterEditor
        active
        baselineContent={"# 第一章\n\n原文"}
        baselineVersion="hash-1"
        path="40_正文/ch001.md"
        onPreview={onPreview}
      />,
    );
    const editor = screen.getByRole("textbox", { name: "章节 Markdown 原文" });
    fireEvent.change(editor, { target: { value: "# 第一章\n\n新文" } });

    const event = new KeyboardEvent("keydown", {
      key: "s",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onPreview).toHaveBeenCalledWith("# 第一章\n\n新文");
  });

  it("非激活状态不拦截 Ctrl/Cmd+S，也不请求保存预览", () => {
    const onPreview = vi.fn();
    render(
      <ChapterEditor
        active={false}
        baselineContent={"# 第一章\n\n原文"}
        baselineVersion="hash-1"
        path="40_正文/ch001.md"
        onPreview={onPreview}
      />,
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "# 第一章\n\n新文" },
    });

    const event = new KeyboardEvent("keydown", {
      key: "s",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(onPreview).not.toHaveBeenCalled();
  });

  it("使用与服务端一致的中英文字数规则，并在新基线版本到达后重置草稿", () => {
    expect(countChapterWords("# 标题\n\n天地 test-one 123")).toBe(4);
    const view = render(
      <ChapterEditor
        baselineContent={"# 第一章\n\n旧文"}
        baselineVersion="hash-1"
        path="40_正文/ch001.md"
        onPreview={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "# 第一章\n\n未保存" },
    });

    view.rerender(
      <ChapterEditor
        baselineContent={"# 第一章\n\n已写入新基线"}
        baselineVersion="hash-2"
        path="40_正文/ch001.md"
        onPreview={vi.fn()}
      />,
    );

    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "# 第一章\n\n已写入新基线",
    );
    expect(screen.getByText("已保存")).toBeTruthy();
  });
});
