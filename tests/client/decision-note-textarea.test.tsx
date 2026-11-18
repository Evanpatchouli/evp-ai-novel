/** @vitest-environment jsdom */
import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DecisionNoteTextarea } from "../../client/src/features/workflow/DecisionNoteTextarea.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("DecisionNoteTextarea", () => {
  it("连续输入即时显示，并按时间间隔限制父状态更新", () => {
    vi.useFakeTimers();
    const onSync = vi.fn();

    function Harness() {
      const [value, setValue] = useState("");
      return (
        <DecisionNoteTextarea
          aria-label="决策备注"
          value={value}
          onValueChange={(next) => {
            onSync(next);
            setValue(next);
          }}
          throttleMs={200}
        />
      );
    }

    render(<Harness />);
    const textarea = screen.getByRole("textbox", { name: "决策备注" });

    fireEvent.change(textarea, { target: { value: "一" } });
    fireEvent.change(textarea, { target: { value: "一段" } });
    fireEvent.change(textarea, { target: { value: "一段备注" } });

    expect(textarea).toHaveProperty("value", "一段备注");
    expect(onSync).toHaveBeenCalledTimes(1);
    expect(onSync).toHaveBeenLastCalledWith("一");

    act(() => vi.advanceTimersByTime(199));
    expect(onSync).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(1));
    expect(onSync).toHaveBeenCalledTimes(2);
    expect(onSync).toHaveBeenLastCalledWith("一段备注");
  });

  it("失焦时立即同步最新值", () => {
    vi.useFakeTimers();
    const onValueChange = vi.fn();
    render(
      <DecisionNoteTextarea
        aria-label="决策备注"
        value=""
        onValueChange={onValueChange}
        throttleMs={500}
      />,
    );
    const textarea = screen.getByRole("textbox", { name: "决策备注" });

    fireEvent.change(textarea, { target: { value: "一" } });
    fireEvent.change(textarea, { target: { value: "最终值" } });
    expect(onValueChange).toHaveBeenCalledTimes(1);

    fireEvent.blur(textarea);

    expect(onValueChange).toHaveBeenCalledTimes(2);
    expect(onValueChange).toHaveBeenLastCalledWith("最终值");
  });

  it("卸载前同步尚未发送的最终值", () => {
    vi.useFakeTimers();
    const onValueChange = vi.fn();
    const view = render(
      <DecisionNoteTextarea
        aria-label="决策备注"
        value=""
        onValueChange={onValueChange}
        throttleMs={500}
      />,
    );
    const textarea = screen.getByRole("textbox", { name: "决策备注" });

    fireEvent.change(textarea, { target: { value: "一" } });
    fireEvent.change(textarea, { target: { value: "卸载前最终值" } });
    view.unmount();

    expect(onValueChange).toHaveBeenCalledTimes(2);
    expect(onValueChange).toHaveBeenLastCalledWith("卸载前最终值");

    act(() => vi.advanceTimersByTime(1_000));
    expect(onValueChange).toHaveBeenCalledTimes(2);
  });
});
