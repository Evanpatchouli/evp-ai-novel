/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ScrollArea } from "../../client/src/components/ScrollArea.js";

afterEach(cleanup);

describe("ScrollArea", () => {
  it("限制可视高度但保留全部子项，并提供键盘滚动语义", () => {
    render(
      <ScrollArea aria-label="文件列表" maxHeight={20 * 39}>
        {Array.from({ length: 25 }, (_, index) => (
          <div key={index}>文件 {index + 1}</div>
        ))}
      </ScrollArea>,
    );

    const area = screen.getByRole("region", { name: "文件列表" });
    expect(area.classList.contains("scroll-area")).toBe(true);
    expect(area.getAttribute("tabindex")).toBe("0");
    expect(area.style.maxHeight).toBe("780px");
    expect(screen.getByText("文件 25")).not.toBeNull();
  });
});
