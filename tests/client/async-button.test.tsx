/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AsyncButton } from "../../client/src/components/AsyncButton.js";

afterEach(cleanup);

describe("AsyncButton", () => {
  it("等待时渲染组件库指示器，完成后移除指示器并恢复操作", () => {
    const { rerender } = render(<AsyncButton>读取</AsyncButton>);
    const button = screen.getByRole("button", { name: "读取" });
    expect(button.querySelector(".animate-spin")).toBeNull();
    expect(button.hasAttribute("loading")).toBe(false);

    rerender(<AsyncButton busy>读取</AsyncButton>);
    expect(
      button.querySelector('.animate-spin[aria-hidden="true"]'),
    ).not.toBeNull();
    expect(button.hasAttribute("loading")).toBe(false);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect((button as HTMLButtonElement).disabled).toBe(true);

    rerender(<AsyncButton>读取</AsyncButton>);
    expect(button.querySelector(".animate-spin")).toBeNull();
    expect(button.hasAttribute("aria-busy")).toBe(false);
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it("空闲时保留调用方的禁用条件", () => {
    render(<AsyncButton disabled>读取</AsyncButton>);
    const button = screen.getByRole("button", { name: "读取" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.querySelector(".animate-spin")).toBeNull();
  });
});
