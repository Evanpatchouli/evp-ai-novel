/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VolumeForm,
  type VolumeFormValues,
} from "../../client/src/features/volumes/VolumeForm.js";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("VolumeForm", () => {
  it("只读展示不可变身份并通过组件库表单提交卷名", async () => {
    const user = userEvent.setup();
    let values: VolumeFormValues = {
      title: "",
    };
    const onSubmit = vi.fn();
    const onChange = vi.fn((next: VolumeFormValues) => {
      values = next;
      rerender(
        <VolumeForm
          mode="create"
          volumeId="v02"
          volumeNumber={2}
          targetPath="40_正文/卷/v02/状态.yaml"
          values={values}
          onChange={onChange}
          onSubmit={onSubmit}
        />,
      );
    });
    const { rerender } = render(
      <VolumeForm
        mode="create"
        volumeId="v02"
        volumeNumber={2}
        targetPath="40_正文/卷/v02/状态.yaml"
        values={values}
        onChange={onChange}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByText("v02")).toBeTruthy();
    expect(screen.getByText("第 2 卷")).toBeTruthy();
    expect(screen.getByText("40_正文/卷/v02/状态.yaml")).toBeTruthy();
    await user.type(screen.getByRole("textbox", { name: "卷名" }), "星火初燃");
    await user.click(screen.getByRole("button", { name: "预览变更" }));
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(values.title).toBe("星火初燃");
  });

  it("编辑模式不允许修改生命周期或创建卷纲", () => {
    render(
      <VolumeForm
        mode="edit"
        volumeId="v01"
        volumeNumber={1}
        targetPath="40_正文/卷/v01/状态.yaml"
        values={{
          title: "长青少年",
        }}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.queryByText("初始状态")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
