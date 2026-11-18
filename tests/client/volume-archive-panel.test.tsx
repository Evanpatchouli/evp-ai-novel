/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  VolumeDetail,
  VolumeMutationPreview,
} from "../../shared/contracts.js";

const previewMock = vi.hoisted(() => vi.fn());
const commitMock = vi.hoisted(() => vi.fn());
const loadDashboardMock = vi.hoisted(() => vi.fn());

vi.mock("../../client/src/api.js", () => ({
  api: {
    previewVolumeArchive: previewMock,
    commitVolumeMutation: commitMock,
  },
}));
vi.mock("../../client/src/app/RepositorySession.js", () => ({
  useRepositorySession: () => ({ loadDashboard: loadDashboardMock }),
}));

import { VolumeArchivePanel } from "../../client/src/features/volumes/VolumeArchivePanel.js";

function volume(chapterCount: number, finalCount = 0): VolumeDetail {
  return {
    id: "v02",
    number: 2,
    title: "星火初燃",
    lifecycleStatus: "planned",
    chapterCount,
    finalCount,
    aiRevisedCount: 0,
    inProgressCount: 0,
    chapters: [],
    totalWordCount: 0,
    statusCounts: {},
    relatedRecords: [],
    healthIssues: [],
  };
}

function renderPanel(value: VolumeDetail) {
  const router = createMemoryRouter(
    [
      { path: "/chapters/volumes/v02", element: <VolumeArchivePanel volume={value} /> },
      { path: "/archive", element: <p>回收站页面</p> },
    ],
    { initialEntries: ["/chapters/volumes/v02"] },
  );
  render(<RouterProvider router={router} />);
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  previewMock.mockReset();
  commitMock.mockReset();
  loadDashboardMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("VolumeArchivePanel", () => {
  it("非空卷直接展示阻断，不提供归档输入", () => {
    renderPanel(volume(4, 2));

    expect(screen.getByText("当前卷非空，不能归档")).toBeTruthy();
    expect(screen.getByText(/4 章.*2 章为终稿/)).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "预览归档影响" })).toBeNull();
  });

  it("空卷确认提交后先刷新会话再导航回收站", async () => {
    const user = userEvent.setup();
    const preview: VolumeMutationPreview = {
      token: "volume-token",
      kind: "archive",
      expiresAt: "2026-07-18T10:00:00.000Z",
      volumeId: "v02",
      volumeNumber: 2,
      targetPath: "40_正文/卷/v02",
      diff: [],
      plannedChanges: ["归档 40_正文/卷/v02"],
      referenceImpacts: [],
      confirmationRequirements: ["confirm-volume-archive"],
      destinationHref: "/archive",
      archiveId: "archive-v02",
    };
    previewMock.mockResolvedValue(preview);
    commitMock.mockResolvedValue({
      kind: "archive",
      volumeId: "v02",
      destinationHref: "/archive",
      archiveId: "archive-v02",
    });
    loadDashboardMock.mockResolvedValue(undefined);
    renderPanel(volume(0));

    await user.click(screen.getByText("归档卷"));
    await user.type(screen.getByRole("textbox"), "结构调整");
    await user.click(screen.getByRole("button", { name: "预览归档影响" }));
    await user.click(
      await screen.findByRole("checkbox", {
        name: "我确认归档整卷及其拥有的规划资产。",
      }),
    );
    await user.click(screen.getByRole("button", { name: "确认归档整卷" }));

    expect(await screen.findByText("回收站页面")).toBeTruthy();
    expect(loadDashboardMock).toHaveBeenCalledOnce();
    expect(commitMock.mock.invocationCallOrder[0]).toBeLessThan(
      loadDashboardMock.mock.invocationCallOrder[0],
    );
    await waitFor(() => expect(commitMock).toHaveBeenCalledOnce());
  });
});
