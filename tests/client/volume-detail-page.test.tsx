/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VolumeDetail } from "../../shared/contracts.js";

const volumeMock = vi.hoisted(() => vi.fn());
const loadDashboardMock = vi.hoisted(() => vi.fn());

vi.mock("../../client/src/api.js", () => ({ api: { volume: volumeMock } }));
vi.mock("../../client/src/app/RepositorySession.js", () => ({
  useRepositorySession: () => ({ loadDashboard: loadDashboardMock }),
}));

import { VolumeDetailPage } from "../../client/src/features/volumes/VolumeDetailPage.js";
import {
  lifecycleLabel,
  presentStatusCounts,
  relatedRecordKindLabel,
} from "../../client/src/features/volumes/volumePresentation.js";

function volume(overrides: Partial<VolumeDetail> = {}): VolumeDetail {
  return {
    id: "v01",
    number: 1,
    title: "长青少年",
    lifecycleStatus: "active",
    chapterCount: 2,
    finalCount: 1,
    aiRevisedCount: 0,
    inProgressCount: 1,
    totalWordCount: 3000,
    statusCounts: { draft: 1, final: 1 },
    chapters: [
      {
        id: "ch001",
        number: 1,
        title: "第一章 山门",
        path: "40_正文/卷/v01/章节/ch001.md",
        status: "final",
        humanApproved: true,
        wordCount: 1400,
        lengthFlag: "normal",
        modifiedAt: "2026-07-18T01:00:00.000Z",
      },
      {
        id: "ch002",
        number: 2,
        title: "第二章 入城",
        path: "40_正文/卷/v01/章节/ch002.md",
        status: "draft",
        humanApproved: false,
        wordCount: 1600,
        lengthFlag: "normal",
        modifiedAt: "2026-07-18T02:00:00.000Z",
      },
    ],
    firstChapter: {
      volumeId: "v01",
      volumeNumber: 1,
      chapterId: "ch001",
      chapterNumber: 1,
      title: "第一章 山门",
    },
    lastChapter: {
      volumeId: "v01",
      volumeNumber: 1,
      chapterId: "ch002",
      chapterNumber: 2,
      title: "第二章 入城",
    },
    currentChapterId: "ch002",
    outline: { path: "20_规划/卷/v01/卷纲.md", title: "第一卷卷纲" },
    relatedRecords: [
      {
        kind: "review",
        path: "50_审稿/卷审/v01/终审检查表.md",
        title: "终审检查表",
      },
    ],
    healthIssues: [],
    ...overrides,
  };
}

function routerAt(path: string) {
  return createMemoryRouter(
    [{ path: "/chapters/volumes/:volumeId", Component: VolumeDetailPage }],
    { initialEntries: [path] },
  );
}

afterEach(() => {
  cleanup();
  volumeMock.mockReset();
  loadDashboardMock.mockReset();
});

describe("卷详情展示纯函数", () => {
  it("状态顺序稳定且保留未知状态", () => {
    expect(
      presentStatusCounts({ experimental: 2, draft: 3, final: 4, empty: 0 }),
    ).toEqual([
      { status: "final", label: "终稿", count: 4 },
      { status: "draft", label: "草稿", count: 3 },
      { status: "experimental", label: "experimental", count: 2 },
    ]);
    expect(lifecycleLabel("active")).toBe("创作中");
    expect(relatedRecordKindLabel("publication")).toBe("发布");
  });
});

describe("VolumeDetailPage", () => {
  it("展示完整统计、卷纲、当前章和相关记录深链接", async () => {
    volumeMock.mockResolvedValue(volume());
    render(<RouterProvider router={routerAt("/chapters/volumes/v01")} />);

    expect(
      await screen.findByRole("heading", { name: "长青少年" }),
    ).toBeTruthy();
    expect(screen.getByText("3,000 字")).toBeTruthy();
    expect(screen.getByRole("list", { name: "章节状态统计" })).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "阅读卷纲：第一卷卷纲" })
        .getAttribute("href"),
    ).toBe(
      "/documents/view?path=20_%E8%A7%84%E5%88%92%2F%E5%8D%B7%2Fv01%2F%E5%8D%B7%E7%BA%B2.md",
    );
    expect(screen.getAllByText("当前处理")).toHaveLength(2);
    expect(
      screen
        .getAllByRole("link", { name: /第二章 入城/ })
        .some(
          (link) => link.getAttribute("href") === "/chapters/volumes/v01/chapters/ch002",
        ),
    ).toBe(true);
    expect(
      screen.getByRole("link", { name: "终审检查表" }).getAttribute("href"),
    ).toContain("%E7%BB%88%E5%AE%A1%E6%A3%80%E6%9F%A5%E8%A1%A8.md");
  });

  it("为空卷显示明确空态", async () => {
    volumeMock.mockResolvedValue(
      volume({
        id: "v02",
        number: 2,
        title: "尚未开篇",
        chapterCount: 0,
        finalCount: 0,
        inProgressCount: 0,
        totalWordCount: 0,
        statusCounts: {},
        chapters: [],
        firstChapter: undefined,
        lastChapter: undefined,
        currentChapterId: undefined,
        outline: undefined,
        relatedRecords: [],
      }),
    );
    render(<RouterProvider router={routerAt("/chapters/volumes/v02")} />);

    expect(await screen.findByText("这一卷还没有章节")).toBeTruthy();
    expect(screen.getByText("尚未建立卷纲。")).toBeTruthy();
    expect(screen.getByText("暂无相关记录")).toBeTruthy();
  });

  it("路由快速切换时旧卷响应不能覆盖新卷", async () => {
    let resolveOld!: (value: VolumeDetail) => void;
    const oldRequest = new Promise<VolumeDetail>((resolve) => {
      resolveOld = resolve;
    });
    volumeMock.mockImplementation((volumeId: string) =>
      volumeId === "v01"
        ? oldRequest
        : Promise.resolve(
            volume({ id: "v02", number: 2, title: "第二卷 新响应" }),
          ),
    );
    const router = routerAt("/chapters/volumes/v01");
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(volumeMock).toHaveBeenCalledWith("v01"));

    await router.navigate("/chapters/volumes/v02");
    expect(
      await screen.findByRole("heading", { name: "第二卷 新响应" }),
    ).toBeTruthy();
    resolveOld(volume());
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "长青少年" })).toBeNull(),
    );
  });
});
