/** @vitest-environment jsdom */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { NovelPicker } from "../../client/src/app/NovelPicker";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("小说切换与删除分别触发，取消删除不会发请求", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const user = userEvent.setup();
  const onSelect = vi.fn();
  const onDelete = vi.fn().mockResolvedValue(undefined);
  const novels = [
    { id: "current", title: "当前作品" },
    { id: "other", title: "另一部作品" },
  ];
  render(
    <NovelPicker
      novels={novels}
      selectedId="current"
      disabled={false}
      hasUnsavedChanges={false}
      onSelect={onSelect}
      onDelete={onDelete}
    />,
  );
  const trigger = screen.getByRole("button", { name: "当前小说：当前作品" });
  await user.click(trigger);
  await user.click(
    await screen.findByRole("button", { name: "删除小说：另一部作品" }),
  );
  await user.click(await screen.findByRole("button", { name: "取消" }));
  expect(onDelete).not.toHaveBeenCalled();
  expect(onSelect).not.toHaveBeenCalled();

  await user.click(
    await screen.findByRole("button", { name: "删除小说：另一部作品" }),
  );
  await user.click(await screen.findByRole("button", { name: "永久删除" }));
  await waitFor(() => expect(screen.queryByText("永久删除小说？")).toBeNull());
  expect(onDelete).toHaveBeenCalledExactlyOnceWith(novels[1]);
  expect(onSelect).not.toHaveBeenCalled();

  await user.click(
    await screen.findByRole("button", { name: "另一部作品", exact: true }),
  );
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("other");
});
