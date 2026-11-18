/** @vitest-environment jsdom */
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Link, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  UnsavedChangesProvider,
  useUnsavedChanges,
  useUnsavedChangesGuard,
} from "../../client/src/app/UnsavedChangesContext.js";

function EditorHarness() {
  const [dirty, setDirty] = useState(false);
  useUnsavedChangesGuard(dirty);
  return (
    <>
      <button type="button" onClick={() => setDirty(true)}>
        修改草稿
      </button>
      <Link to="/next">下一页</Link>
    </>
  );
}

function RepositorySwitchHarness({ onSwitch }: { onSwitch: () => void }) {
  const [dirty] = useState(true);
  const { requestDiscard } = useUnsavedChanges();
  useUnsavedChangesGuard(dirty);
  return (
    <button
      type="button"
      onClick={() =>
        void requestDiscard().then((allowed) => allowed && onSwitch())
      }
    >
      切换仓库
    </button>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("UnsavedChangesProvider", () => {
  it("阻止路由离开，取消后留在原页，确认后继续导航", async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter(
      [
        { path: "/", element: <EditorHarness /> },
        { path: "/next", element: <h1>已离开</h1> },
      ],
      { initialEntries: ["/"] },
    );
    render(
      <UnsavedChangesProvider>
        <RouterProvider router={router} />
      </UnsavedChangesProvider>,
    );

    await user.click(screen.getByRole("button", { name: "修改草稿" }));
    await user.click(screen.getByRole("link", { name: "下一页" }));
    expect(
      screen.getByRole("heading", { name: "放弃未保存的修改？" }),
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "继续编辑" }));
    expect(screen.queryByRole("heading", { name: "已离开" })).toBeNull();

    await user.click(screen.getByRole("link", { name: "下一页" }));
    await user.click(screen.getByRole("button", { name: "放弃并离开" }));
    expect(await screen.findByRole("heading", { name: "已离开" })).toBeTruthy();
  });

  it("为刷新注册 beforeunload，并允许仓库切换共用同一确认", async () => {
    const user = userEvent.setup();
    const onSwitch = vi.fn();
    const router = createMemoryRouter(
      [{ path: "/", element: <RepositorySwitchHarness onSwitch={onSwitch} /> }],
      { initialEntries: ["/"] },
    );
    render(
      <UnsavedChangesProvider>
        <RouterProvider router={router} />
      </UnsavedChangesProvider>,
    );

    const event = new Event("beforeunload", { cancelable: true });
    fireEvent(window, event);
    expect(event.defaultPrevented).toBe(true);

    await user.click(screen.getByRole("button", { name: "切换仓库" }));
    expect(onSwitch).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "放弃并离开" }));
    expect(onSwitch).toHaveBeenCalledOnce();
  });
});
