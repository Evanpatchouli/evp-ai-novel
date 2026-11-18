/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChapterSummary,
  DashboardData,
  VolumeSummary,
} from "../../shared/contracts.js";

const session = vi.hoisted(() => ({ dashboard: null as DashboardData | null }));

vi.mock("../../client/src/app/RepositorySession.js", () => ({
  useRepositorySession: () => session,
}));

import { ChaptersPage } from "../../client/src/features/chapters/ChaptersPage.js";
import { overviewStorageKey } from "../../client/src/features/chapters/overviewState.js";

const storageValues = new Map<string, string>();
const testStorage: Storage = {
  get length() {
    return storageValues.size;
  },
  clear: () => storageValues.clear(),
  getItem: (key) => storageValues.get(key) ?? null,
  key: (index) => [...storageValues.keys()][index] ?? null,
  removeItem: (key) => {
    storageValues.delete(key);
  },
  setItem: (key, value) => {
    storageValues.set(key, value);
  },
};

function chapter(
  id: string,
  number: number,
  title: string,
  status: string = "draft",
): ChapterSummary {
  return {
    id,
    number,
    title,
    path: `40_正文/卷/v01/章节/${id}.md`,
    status,
    humanApproved: status === "final",
    wordCount: number === 1 ? 800 : 1800,
    lengthFlag: number === 1 ? "short" : "normal",
  };
}

function volume(
  id: string,
  number: number,
  lifecycleStatus: VolumeSummary["lifecycleStatus"],
  chapters: ChapterSummary[],
): VolumeSummary {
  return {
    id,
    number,
    title: `测试卷 ${number}`,
    lifecycleStatus,
    chapterCount: chapters.length,
    finalCount: chapters.filter((item) => item.status === "final").length,
    aiRevisedCount: chapters.filter((item) => item.status === "ai-revised")
      .length,
    inProgressCount: chapters.filter(
      (item) => !["final", "ai-revised"].includes(item.status),
    ).length,
    chapters,
  };
}

function dashboard(volumes: VolumeSummary[]): DashboardData {
  return {
    repositoryRoot: "C:/novel-a",
    projectName: "测试小说",
    volumes,
    currentTask: {
      id: "task-1",
      volumeId: "v02",
      chapterId: "ch003",
      stage: "created",
      createdAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z",
      directory: "30_生产/active/task-1",
      nextAction: "继续",
      pendingDecisionCount: 0,
    },
    health: { healthy: true, issues: [] },
    git: {
      branch: "master",
      clean: true,
      ahead: 0,
      behind: 0,
      changes: [],
      plainLanguage: [],
      suggestedCommitMessage: "",
      suggestedCommands: [],
    },
    continuity: {
      characterFiles: 0,
      activeForeshadowFiles: 0,
      timelineFiles: 0,
      unresolvedReviewItems: 0,
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", testStorage);
});

afterEach(() => {
  cleanup();
  testStorage.clear();
  session.dashboard = null;
  vi.unstubAllGlobals();
});

describe("ChaptersPage", () => {
  it("展示全部卷，默认展开当前任务卷，并提供语义详情链接", async () => {
    session.dashboard = dashboard([
      volume("v01", 1, "active", [
        chapter("ch001", 1, "第一章 焦枝", "final"),
        chapter("ch002", 2, "第二章 星火"),
      ]),
      volume("v02", 2, "planned", [chapter("ch003", 3, "第三章 远行")]),
      volume("v03", 3, "planned", []),
    ]);

    render(
      <MemoryRouter>
        <ChaptersPage />
      </MemoryRouter>,
    );

    expect(screen.getAllByRole("link", { name: "查看卷详情" })).toHaveLength(3);
    expect(
      screen.getByRole("link", { name: /第三章 远行/ }).getAttribute("href"),
    ).toBe("/chapters/volumes/v02/chapters/ch003");

    fireEvent.click(screen.getByRole("button", { name: /第 1 卷/ }));
    expect(
      screen.getByRole("link", { name: /第一章 焦枝/ }).getAttribute("href"),
    ).toBe("/chapters/volumes/v01/chapters/ch001");
    expect(screen.getByLabelText("篇幅：800 字，偏短").textContent).toContain(
      "800 字 · 偏短",
    );
    expect(
      JSON.parse(
        localStorage.getItem(overviewStorageKey("C:/novel-a")) ?? "[]",
      ),
    ).toEqual(expect.arrayContaining(["v01", "v02"]));
  });

  it("筛选会临时展开匹配卷，清空后恢复仓库偏好", () => {
    localStorage.setItem(
      overviewStorageKey("C:/novel-a"),
      JSON.stringify(["v02"]),
    );
    session.dashboard = dashboard([
      volume("v01", 1, "active", [chapter("ch001", 1, "第一章 焦枝")]),
      volume("v02", 2, "planned", [chapter("ch003", 3, "第三章 远行")]),
    ]);

    render(
      <MemoryRouter>
        <ChaptersPage />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText("筛选章节"), {
      target: { value: "焦枝" },
    });
    expect(screen.getByRole("link", { name: /第一章 焦枝/ })).toBeTruthy();
    expect(screen.queryByText("第三章 远行")).toBeNull();

    fireEvent.change(screen.getByLabelText("筛选章节"), {
      target: { value: "" },
    });
    expect(screen.getByRole("link", { name: /第三章 远行/ })).toBeTruthy();
    expect(localStorage.getItem(overviewStorageKey("C:/novel-a"))).toBe(
      JSON.stringify(["v02"]),
    );
  });

  it("为空小说显示明确空状态", () => {
    session.dashboard = dashboard([]);
    render(
      <MemoryRouter>
        <ChaptersPage />
      </MemoryRouter>,
    );
    expect(screen.getByText("当前小说还没有卷")).toBeTruthy();
  });
});
