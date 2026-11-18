/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiffView } from "../../client/src/features/workflow/DiffView.js";

afterEach(cleanup);

describe("DiffView", () => {
  const longUnchanged = `开头上下文${"未变化正文".repeat(80)}结尾上下文`;
  const changes = [
    { type: "unchanged" as const, value: longUnchanged },
    { type: "removed" as const, value: "旧句子" },
    { type: "added" as const, value: "新句子" },
  ];

  it("默认聚焦改动并允许切换完整上下文", () => {
    render(<DiffView changes={changes} />);

    expect(screen.getByText(/已折叠 \d+ 字未改正文/)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "仅看改动" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "完整上下文" }));

    expect(screen.queryByText(/已折叠 \d+ 字未改正文/)).toBeNull();
    expect(screen.getByText(longUnchanged)).toBeTruthy();
  });

  it("显示改动数量并支持逐处导航", () => {
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    render(<DiffView changes={changes} />);

    expect(screen.getByText("2 处改动")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "下一处改动" }));

    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
  });
});
