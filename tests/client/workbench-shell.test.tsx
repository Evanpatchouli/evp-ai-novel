/** @vitest-environment jsdom */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OverlayScrollbars } from "overlayscrollbars";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../../client/src/api";
import { AppearanceProvider } from "../../client/src/app/appearance";
import { WorkbenchShell } from "../../client/src/app/WorkbenchShell";

afterEach(cleanup);

it.each(["complementary", "main"] as const)(
  "空书库的 %s 新建入口打开同一表单并恢复焦点",
  async (landmark) => {
    vi.spyOn(api, "novels").mockResolvedValue({ novels: [], selectedId: null });
    const user = userEvent.setup();
    const router = createMemoryRouter([
      { path: "/", Component: WorkbenchShell },
    ]);
    render(
      <AppearanceProvider initialAppearance="plain">
        <RouterProvider router={router} />
      </AppearanceProvider>,
    );

    await screen.findByText("书库中还没有小说");
    const trigger = within(screen.getByRole(landmark)).getByRole("button", {
      name: "新建小说",
    });
    const picker = screen.getByRole("button", { name: "当前小说" });
    expect(picker.hasAttribute("disabled")).toBe(true);
    expect(screen.queryByText(/^(未连接|等待读取|0 项未提交)$/)).toBeNull();
    await user.click(trigger);
    const title = within(screen.getByRole("dialog")).getByRole("textbox", {
      name: "书名",
    });
    expect(document.activeElement).toBe(title);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  },
);

it("主视图在跳转时回到顶部，并在前进后退时恢复各自的滚动位置", async () => {
  vi.spyOn(api, "novels").mockResolvedValue({ novels: [], selectedId: null });
  const windowScroll = vi
    .spyOn(window, "scrollTo")
    .mockImplementation(() => {});
  const user = userEvent.setup();
  const router = createMemoryRouter([
    {
      path: "/",
      Component: WorkbenchShell,
      children: [
        { index: true, element: null },
        { path: "archive", element: null },
      ],
    },
  ]);
  render(
    <AppearanceProvider initialAppearance="plain">
      <RouterProvider router={router} />
    </AppearanceProvider>,
  );

  await screen.findByText("书库中还没有小说");
  const viewport = screen.getByRole("region", { name: "主视图内容" });
  const scrollTo = vi.fn();
  Object.defineProperty(viewport, "scrollTo", { value: scrollTo });
  expect(viewport.tabIndex).toBe(0);
  const scrollbars = OverlayScrollbars(viewport.parentElement!);
  expect(scrollbars?.elements().viewport).toBe(viewport);
  expect(scrollbars?.options().scrollbars).toMatchObject({
    theme: "os-theme-workbench",
    autoHide: "scroll",
    visibility: "auto",
  });

  viewport.scrollTop = 420;
  fireEvent.scroll(viewport);
  await user.click(screen.getByRole("link", { name: /回收站/ }));
  expect(viewport.scrollTop).toBe(0);

  viewport.scrollTop = 170;
  fireEvent.scroll(viewport);
  await act(() => router.navigate(-1));
  expect(viewport.scrollTop).toBe(420);
  await act(() => router.navigate(1));
  expect(viewport.scrollTop).toBe(170);

  await user.click(screen.getByRole("button", { name: "页面快捷操作" }));
  const scrollButton = screen.getByRole("button", { name: "回到顶部" });
  await waitFor(() =>
    expect(scrollButton.parentElement?.parentElement?.style.pointerEvents).toBe(
      "auto",
    ),
  );
  await user.click(scrollButton);
  expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
  expect(windowScroll).not.toHaveBeenCalled();
});
