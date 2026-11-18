/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMemo } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PageQuickActionsProvider,
  usePageQuickActions,
} from "../../client/src/app/PageQuickActionsContext.js";
import { GlobalQuickActions } from "../../client/src/components/GlobalQuickActions.js";

afterEach(cleanup);

describe("GlobalQuickActions", () => {
  it("展开后可刷新当前页面", async () => {
    const reloadPage = vi.fn();
    const user = userEvent.setup();
    render(
      <GlobalQuickActions reloadPage={reloadPage} scrollToTop={vi.fn()} />,
    );

    await user.click(screen.getByRole("button", { name: "页面快捷操作" }));
    const reloadButton = screen.getByRole("button", { name: "刷新页面" });
    await waitFor(() =>
      expect(
        reloadButton.parentElement?.parentElement?.style.pointerEvents,
      ).toBe("auto"),
    );
    await user.click(reloadButton);

    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  it("展开后可回到页面顶部", async () => {
    const scrollToTop = vi.fn();
    const user = userEvent.setup();
    render(
      <GlobalQuickActions reloadPage={vi.fn()} scrollToTop={scrollToTop} />,
    );

    await user.click(screen.getByRole("button", { name: "页面快捷操作" }));
    const scrollButton = screen.getByRole("button", { name: "回到顶部" });
    await waitFor(() =>
      expect(
        scrollButton.parentElement?.parentElement?.style.pointerEvents,
      ).toBe("auto"),
    );
    await user.click(scrollButton);

    expect(scrollToTop).toHaveBeenCalledTimes(1);
  });

  it("合并页面注册动作且不影响固定动作", async () => {
    const pageAction = vi.fn();
    const user = userEvent.setup();

    function PageActions() {
      const actions = useMemo(
        () => [
          {
            itemKey: "edit-chapter",
            label: "编辑章节",
            icon: <span aria-hidden="true">编</span>,
            onClick: pageAction,
          },
        ],
        [],
      );
      usePageQuickActions(actions);
      return null;
    }

    render(
      <PageQuickActionsProvider>
        <PageActions />
        <GlobalQuickActions reloadPage={vi.fn()} scrollToTop={vi.fn()} />
      </PageQuickActionsProvider>,
    );

    await user.click(screen.getByRole("button", { name: "页面快捷操作" }));
    const editButton = await screen.findByRole("button", {
      name: "编辑章节",
    });
    await waitFor(() =>
      expect(editButton.parentElement?.parentElement?.style.pointerEvents).toBe(
        "auto",
      ),
    );
    await user.click(editButton);

    expect(pageAction).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "刷新页面" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "回到顶部" })).toBeTruthy();
  });

  it("页面动作可更新，并在注册组件卸载后清理", async () => {
    const user = userEvent.setup();

    function PageActions({ editing }: { editing: boolean }) {
      const actions = useMemo(
        () => [
          {
            itemKey: "toggle-mode",
            label: editing ? "预览章节" : "编辑章节",
            icon: <span aria-hidden="true">切</span>,
            onClick: vi.fn(),
          },
        ],
        [editing],
      );
      usePageQuickActions(actions);
      return null;
    }

    const { rerender } = render(
      <PageQuickActionsProvider>
        <PageActions editing={false} />
        <GlobalQuickActions />
      </PageQuickActionsProvider>,
    );
    await user.click(screen.getByRole("button", { name: "页面快捷操作" }));
    expect(
      await screen.findByRole("button", { name: "编辑章节" }),
    ).toBeTruthy();

    rerender(
      <PageQuickActionsProvider>
        <PageActions editing />
        <GlobalQuickActions />
      </PageQuickActionsProvider>,
    );
    expect(
      await screen.findByRole("button", { name: "预览章节" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "编辑章节" })).toBeNull();

    rerender(
      <PageQuickActionsProvider>
        <GlobalQuickActions />
      </PageQuickActionsProvider>,
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "预览章节" })).toBeNull(),
    );
  });
});
