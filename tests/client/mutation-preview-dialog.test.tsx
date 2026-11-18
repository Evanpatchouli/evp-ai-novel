/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MutationPreviewDialog } from "../../client/src/components/MutationPreviewDialog.js";

afterEach(cleanup);

describe("MutationPreviewDialog", () => {
  it("删除预览在逐项确认后打开锚定确认，只有再次确认才提交", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <MutationPreviewDialog
        open
        title="删除章节预览"
        preview={{
          targetPath: "40_正文/ch001.md",
          diff: [],
          confirmationRequirements: ["confirm-chapter-delete"],
        }}
        confirmDeletion
        confirmLabel="永久删除章节"
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    const trigger = screen.getByRole("button", { name: "永久删除章节" });
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: /永久删除本章/ }));
    await user.click(trigger);
    expect(onConfirm).not.toHaveBeenCalled();
    await user.click(
      await screen.findByRole("button", { name: "永久删除", exact: true }),
    );
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
  it("展示完整差异、路径、字数和引用影响，且只在明确确认时提交", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <MutationPreviewDialog
        open
        title="保存章节预览"
        description="确认后才会写入正式 Markdown。"
        preview={{
          targetPath: "40_正文/卷/v01/章节/ch016.md",
          beforeWordCount: 1200,
          afterWordCount: 1225,
          expiresAt: "2026-07-18T10:00:00.000Z",
          diff: [
            { type: "unchanged", value: "# 第十六章\n" },
            { type: "removed", value: "旧句子" },
            { type: "added", value: "新句子" },
          ],
          referenceImpacts: [
            {
              path: "20_规划/卷/v01/卷纲.md",
              severity: "warning",
              evidence: "提及 ch016",
            },
          ],
        }}
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByText("40_正文/卷/v01/章节/ch016.md")).toBeTruthy();
    expect(screen.getByText("1,200 → 1,225 字")).toBeTruthy();
    expect(screen.getByText("旧句子")).toBeTruthy();
    expect(screen.getByText("新句子")).toBeTruthy();
    expect(screen.getByText("20_规划/卷/v01/卷纲.md")).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "确认写入" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("忙碌时禁止取消和确认", () => {
    render(
      <MutationPreviewDialog
        open
        busy
        title="恢复预览"
        preview={{ targetPath: "40_正文/ch001.md", diff: [] }}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    expect(
      (screen.getByRole("button", { name: "取消" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "确认写入",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("卷操作支持自定义差异标题并要求逐项确认", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <MutationPreviewDialog
        open
        title="归档卷预览"
        diffTitle="归档清单完整差异"
        preview={{
          targetPath: "40_正文/卷/v01",
          diff: [],
          confirmationRequirements: ["confirm-volume-archive"],
        }}
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByText("归档清单完整差异")).toBeTruthy();
    const submit = screen.getByRole("button", { name: "确认写入" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await user.click(
      screen.getByRole("checkbox", {
        name: "我确认归档整卷及其拥有的规划资产。",
      }),
    );
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    await user.click(submit);
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("确认说明位于固定尺寸复选框之外并由标签关联", () => {
    const confirmationLabel = "我确认创建可选的小说元数据 YAML。";
    render(
      <MutationPreviewDialog
        open
        title="创建小说元数据预览"
        preview={{
          targetPath: "00_项目/小说.yaml",
          diff: [],
          confirmationRequirements: ["confirm-novel-metadata-create"],
        }}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    const checkbox = screen.getByRole("checkbox", { name: confirmationLabel });
    const text = screen.getByText(confirmationLabel);

    expect(checkbox.contains(text)).toBe(false);
    expect(text.closest("label")).not.toBeNull();
  });

  it("存在阻断引用时即使没有确认项也禁止提交", () => {
    render(
      <MutationPreviewDialog
        open
        title="归档卷预览"
        preview={{
          targetPath: "40_正文/卷/v01",
          diff: [],
          referenceImpacts: [
            {
              path: "30_生产/active/task",
              severity: "blocking",
              evidence: "存在活动任务",
            },
          ],
        }}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    expect(
      (screen.getByRole("button", { name: "确认写入" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
