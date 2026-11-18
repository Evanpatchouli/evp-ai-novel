/** @vitest-environment jsdom */
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DocumentArchiveEntry } from "../../shared/contracts";
import { api } from "../../client/src/api";
import { ArchivePage } from "../../client/src/features/chapters/ArchivePage";

vi.mock("../../client/src/app/RepositorySession", () => ({
  useRepositorySession: () => ({ loadDashboard: vi.fn() }),
}));

const documentEntry: DocumentArchiveEntry = {
  id: "archived-document",
  title: "人物设置",
  originalPath: "10_圣经/人物设置.md",
  archivePath: "99_归档/工作台回收站/人物设置.md",
  reason: "设定合并",
  authority: "bible",
  archivedAt: "2026-11-19T01:00:00Z",
  restorable: true,
};

beforeEach(() => {
  vi.spyOn(api, "volumeArchives").mockResolvedValue([]);
  vi.spyOn(api, "documentArchives").mockResolvedValue([]);
  vi.spyOn(api, "chapterArchives").mockResolvedValue([]);
});

afterEach(cleanup);

it("三类归档共用一个标签面板，空库只显示一处空状态", async () => {
  const user = userEvent.setup();
  render(<ArchivePage />);

  const tabs = await screen.findByRole("tablist", { name: "归档类型" });
  expect(within(tabs).getAllByRole("tab")).toHaveLength(3);
  expect(
    within(tabs).getByRole("tab", { name: "卷归档 0 条记录", selected: true }),
  ).toBeTruthy();
  expect(screen.getAllByText("回收站为空")).toHaveLength(1);

  await user.click(
    within(tabs).getByRole("tab", { name: "章节归档 0 条记录" }),
  );
  expect(
    screen.getByRole("tabpanel", { name: "章节归档 0 条记录" }),
  ).toBeTruthy();
  expect(screen.getAllByText("回收站为空")).toHaveLength(1);
});

it("优先打开有记录的分类，恢复后更新记录并保留当前分类", async () => {
  const user = userEvent.setup();
  vi.mocked(api.documentArchives)
    .mockResolvedValueOnce([documentEntry])
    .mockResolvedValueOnce([
      {
        ...documentEntry,
        restorable: false,
        restoredAt: "2026-11-19T02:00:00Z",
      },
    ]);
  const preview = vi.spyOn(api, "previewDocumentRestore").mockResolvedValue({
    kind: "restore",
    token: "restore-document",
    archiveId: documentEntry.id,
    targetPath: documentEntry.originalPath,
    diff: [],
    plannedChanges: [],
    referenceImpacts: [],
    confirmationRequirements: [],
    expiresAt: "2026-11-19T03:00:00Z",
    destinationHref: "/documents",
  });
  const commit = vi.spyOn(api, "commitDocumentMutation").mockResolvedValue({
    kind: "restore",
    archiveId: documentEntry.id,
    destinationHref: "/documents",
  });
  render(<ArchivePage />);

  const panel = await screen.findByRole("tabpanel", {
    name: "文档归档 1 条记录",
  });
  expect(within(panel).getByText(documentEntry.title)).toBeTruthy();
  expect(within(panel).getByText(documentEntry.originalPath)).toBeTruthy();
  expect(within(panel).getByText(documentEntry.archivePath)).toBeTruthy();

  await user.click(within(panel).getByRole("button", { name: "预览恢复" }));
  expect(preview).toHaveBeenCalledWith(documentEntry.id);
  expect(await screen.findByText("恢复文档预览")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "确认恢复文档" }));

  expect(commit).toHaveBeenCalledWith("restore-document", []);
  await waitFor(() => expect(within(panel).getByText("已恢复")).toBeTruthy());
  expect(
    screen.getByRole("tab", { name: "文档归档 1 条记录", selected: true }),
  ).toBeTruthy();
});
