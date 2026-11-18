/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

Object.defineProperty(URL, "createObjectURL", {
  configurable: true,
  value: vi.fn(() => "blob:cover-preview"),
});
Object.defineProperty(URL, "revokeObjectURL", {
  configurable: true,
  value: vi.fn(),
});

const mocks = vi.hoisted(() => ({
  novelMetadata: vi.fn(),
  previewNovelMetadata: vi.fn(),
  commitNovelMetadata: vi.fn(),
  loadDashboard: vi.fn(),
  showNotice: vi.fn(),
}));

vi.mock("../../client/src/api.js", () => ({
  api: {
    novelMetadata: mocks.novelMetadata,
    previewNovelMetadata: mocks.previewNovelMetadata,
    commitNovelMetadata: mocks.commitNovelMetadata,
  },
}));
vi.mock("../../client/src/app/RepositorySession.js", () => ({
  useRepositorySession: () => ({
    loadDashboard: mocks.loadDashboard,
    showNotice: mocks.showNotice,
  }),
}));

import { UnsavedChangesProvider } from "../../client/src/app/UnsavedChangesContext.js";
import { NovelMetadataPage } from "../../client/src/features/documents/NovelMetadataPage.js";

afterEach(() => {
  cleanup();
  Object.values(mocks).forEach((mock) => mock.mockReset());
});

describe("NovelMetadataPage", () => {
  it("兼容缺失 YAML，并只通过结构化表单生成完整预览", async () => {
    const user = userEvent.setup();
    mocks.novelMetadata.mockResolvedValue({
      exists: false,
      path: "00_项目/小说.yaml",
      metadata: {
        schema_version: 1,
        novel: {
          id: "novel",
          title: "示例小说",
          author: "",
          description: "",
        },
      },
    });
    mocks.previewNovelMetadata.mockResolvedValue({
      token: "novel-token",
      kind: "create",
      expiresAt: "2026-07-18T01:00:00.000Z",
      targetPath: "00_项目/小说.yaml",
      diff: [{ type: "added", value: "author: 作者" }],
      plannedChanges: ["创建 00_项目/小说.yaml"],
      referenceImpacts: [],
      confirmationRequirements: ["confirm-novel-metadata-create"],
      destinationHref: "/novel",
    });
    const router = createMemoryRouter(
      [{ path: "/novel", Component: NovelMetadataPage }],
      { initialEntries: ["/novel"] },
    );
    const { container } = render(
      <UnsavedChangesProvider>
        <RouterProvider router={router} />
      </UnsavedChangesProvider>,
    );

    expect(await screen.findByText("可选元数据尚不存在")).toBeTruthy();
    const cover = new File([new Uint8Array([137, 80, 78, 71])], "封面.png", {
      type: "image/png",
    });
    await user.upload(
      container.querySelector('input[type="file"]') as HTMLInputElement,
      cover,
    );
    await user.type(screen.getByRole("textbox", { name: "作者" }), "作者");
    await user.click(screen.getByRole("button", { name: "预览 YAML 变更" }));

    await waitFor(() =>
      expect(mocks.previewNovelMetadata).toHaveBeenCalledWith(
        {
          title: "示例小说",
          author: "作者",
          description: "",
          currentVolume: "",
          currentChapter: "",
        },
        undefined,
        cover,
      ),
    );
    expect(screen.getByText("YAML 完整差异")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "确认写入" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
