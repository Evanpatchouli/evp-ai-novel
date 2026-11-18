/** @vitest-environment jsdom */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskStage } from "../../shared/contracts.js";
import { StageRail } from "../../client/src/features/workflow/StageRail.js";

afterEach(cleanup);

describe("StageRail", () => {
  it("提供移动端可折叠的完整步骤列表", () => {
    render(<StageRail stage="review-imported" />);

    const toggle = screen.getByRole("button", { name: "查看全部步骤" });
    const listId = toggle.getAttribute("aria-controls");
    const list = listId ? document.getElementById(listId) : null;

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(list?.classList.contains("expanded")).toBe(false);

    fireEvent.click(toggle);

    expect(
      screen
        .getByRole("button", { name: "收起全部步骤" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(list?.classList.contains("expanded")).toBe(true);
  });

  it("允许选择已完成阶段并在确认后请求回退", () => {
    const onRewind = vi.fn();
    render(
      <StageRail stage="review-imported" busy={false} onRewind={onRewind} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "返回准备上下文" }));

    expect(
      screen.getByRole("heading", { name: "回退到“准备上下文”？" }),
    ).toBeTruthy();
    expect(screen.getByText(/旧的审稿及后续产物会移入历史目录/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "确认回退" }));
    expect(onRewind).toHaveBeenCalledWith("created");
  });

  it("当前阶段和未来阶段不可作为回退目标", () => {
    render(
      <StageRail stage="review-imported" busy={false} onRewind={vi.fn()} />,
    );

    expect(screen.getByRole("button", { name: "返回导入审稿" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "返回人工决策" })).toBeNull();
    const list = screen.getByRole("list");
    expect(
      within(list)
        .getByText("人工决策")
        .closest("li")
        ?.getAttribute("aria-current"),
    ).toBe("step");
  });

  it.each<[TaskStage, string, string]>([
    ["created", "准备上下文", "2 / 9"],
    ["context-ready", "导入审稿", "3 / 9"],
    ["review-imported", "人工决策", "4 / 9"],
    ["decisions-recorded", "导入修订", "5 / 9"],
    ["revision-imported", "人工终审", "6 / 9"],
    ["human-final-review", "确认写入", "7 / 9"],
    ["ready-to-write", "写入正文", "8 / 9"],
    ["written", "结束任务", "9 / 9"],
    ["archived", "结束任务", "9 / 9"],
  ])("%s 映射到待操作步骤 %s", (stage, label, progress) => {
    render(<StageRail stage={stage} />);

    expect(screen.getByText(progress)).toBeTruthy();
    const list = screen.getByRole("list");
    expect(
      within(list).getByText(label).closest("li")?.getAttribute("aria-current"),
    ).toBe("step");
  });

  it.each<[string, TaskStage]>([
    ["准备上下文", "created"],
    ["导入审稿", "context-ready"],
    ["人工决策", "review-imported"],
    ["导入修订", "decisions-recorded"],
    ["人工终审", "revision-imported"],
    ["确认写入", "human-final-review"],
  ])("返回%s会恢复到它开始前的检查点", (label, target) => {
    const onRewind = vi.fn();
    render(
      <StageRail stage="ready-to-write" busy={false} onRewind={onRewind} />,
    );

    fireEvent.click(screen.getByRole("button", { name: `返回${label}` }));
    fireEvent.click(screen.getByRole("button", { name: "确认回退" }));

    expect(onRewind).toHaveBeenCalledWith(target);
  });

  it.each(["written", "archived"] as const)(
    "%s 阶段不再提供任何回退入口",
    (stage) => {
      render(<StageRail stage={stage} busy={false} onRewind={vi.fn()} />);

      expect(screen.queryAllByRole("button", { name: /^返回/ })).toHaveLength(
        0,
      );
    },
  );
});
