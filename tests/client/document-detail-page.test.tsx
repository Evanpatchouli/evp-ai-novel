/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  document: vi.fn(),
  documentTree: vi.fn(),
  documents: vi.fn(),
  previewDocumentEdit: vi.fn(),
  commitDocumentMutation: vi.fn(),
  open: vi.fn(),
  showNotice: vi.fn(),
}));

vi.mock("../../client/src/api.js", () => ({
  api: {
    document: mocks.document,
    documentTree: mocks.documentTree,
    documents: mocks.documents,
    previewDocumentEdit: mocks.previewDocumentEdit,
    commitDocumentMutation: mocks.commitDocumentMutation,
    open: mocks.open,
  },
}));

vi.mock("../../client/src/app/RepositorySession.js", () => ({
  useRepositorySession: () => ({ showNotice: mocks.showNotice }),
}));

import { DocumentDetailPage } from "../../client/src/features/documents/DocumentDetailPage.js";
import { DocumentsPage } from "../../client/src/features/documents/DocumentsPage.js";
import { UnsavedChangesProvider } from "../../client/src/app/UnsavedChangesContext.js";

function DetailWithGuard() {
  return (
    <UnsavedChangesProvider>
      <DocumentDetailPage />
    </UnsavedChangesProvider>
  );
}

function detailRouter(path: string) {
  return createMemoryRouter(
    [{ path: "/documents/view", Component: DetailWithGuard }],
    { initialEntries: [path] },
  );
}

afterEach(() => {
  cleanup();
  Object.values(mocks).forEach((mock) => mock.mockReset());
});

beforeEach(() => {
  mocks.documentTree.mockResolvedValue([]);
});

describe("DocumentDetailPage", () => {
  it("安全渲染 Markdown、去重首 H1 并警告归档权威等级", async () => {
    mocks.document.mockResolvedValue({
      path: "99_归档/旧设定.md",
      authority: "archive",
      content: "# 旧设定\n\n只读正文。\n\n<img src=x onerror=alert(1)>\n",
    });
    render(
      <RouterProvider
        router={detailRouter(
          "/documents/view?path=99_%E5%BD%92%E6%A1%A3%2F%E6%97%A7%E8%AE%BE%E5%AE%9A.md",
        )}
      />,
    );

    expect(await screen.findByRole("heading", { name: "旧设定" })).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByText("只读正文。")).toBeTruthy();
    expect(document.querySelector("img[src='x']")).toBeNull();
    expect(screen.getByText(/归档内容不是当前事实来源/)).toBeTruthy();
    expect(mocks.document).toHaveBeenCalledWith("99_归档/旧设定.md");
  });

  it("缺少 path 时直接显示错误且不发请求", async () => {
    render(<RouterProvider router={detailRouter("/documents/view")} />);

    expect(await screen.findByText("地址中缺少文档路径")).toBeTruthy();
    expect(mocks.document).not.toHaveBeenCalled();
  });

  it("查询参数快速变化时忽略旧文档响应", async () => {
    let resolveOld!: (value: {
      path: string;
      authority: "bible";
      content: string;
    }) => void;
    const oldRequest = new Promise<{
      path: string;
      authority: "bible";
      content: string;
    }>((resolve) => {
      resolveOld = resolve;
    });
    mocks.document.mockImplementation((path: string) =>
      path === "10_圣经/旧.md"
        ? oldRequest
        : Promise.resolve({
            path: "10_圣经/新.md",
            authority: "bible",
            content: "# 新文档\n\n新内容。\n",
          }),
    );
    const router = detailRouter(
      "/documents/view?path=10_%E5%9C%A3%E7%BB%8F%2F%E6%97%A7.md",
    );
    render(<RouterProvider router={router} />);
    await waitFor(() =>
      expect(mocks.document).toHaveBeenCalledWith("10_圣经/旧.md"),
    );

    await router.navigate(
      "/documents/view?path=10_%E5%9C%A3%E7%BB%8F%2F%E6%96%B0.md",
    );
    expect(await screen.findByRole("heading", { name: "新文档" })).toBeTruthy();
    resolveOld({
      path: "10_圣经/旧.md",
      authority: "bible",
      content: "# 旧文档\n\n旧内容。\n",
    });
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "旧文档" })).toBeNull(),
    );
  });

  it("只按服务端 capability 开放编辑并在统一预览后提交", async () => {
    const user = userEvent.setup();
    mocks.document.mockResolvedValue({
      path: "10_圣经/人物/主角.md",
      authority: "bible",
      content: "# 主角\n\n旧内容。\n",
      sourceHash: "hash-old",
      modifiedAt: "2026-07-18T00:00:00.000Z",
      size: 24,
      capabilities: {
        readable: true,
        creatable: false,
        editable: true,
        archivable: true,
      },
    });
    mocks.previewDocumentEdit.mockResolvedValue({
      token: "document-token",
      kind: "edit",
      expiresAt: "2026-07-18T01:00:00.000Z",
      targetPath: "10_圣经/人物/主角.md",
      diff: [{ type: "added", value: "新内容。" }],
      plannedChanges: ["修改 Markdown 文档"],
      referenceImpacts: [],
      confirmationRequirements: ["confirm-document-edit"],
      destinationHref:
        "/documents/view?path=10_%E5%9C%A3%E7%BB%8F%2F%E4%BA%BA%E7%89%A9%2F%E4%B8%BB%E8%A7%92.md",
    });
    render(
      <RouterProvider
        router={detailRouter(
          "/documents/view?path=10_%E5%9C%A3%E7%BB%8F%2F%E4%BA%BA%E7%89%A9%2F%E4%B8%BB%E8%A7%92.md",
        )}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "编辑 Markdown" }),
    );
    const editor = screen.getByRole("textbox", {
      name: "文档 Markdown 原文",
    });
    await user.clear(editor);
    await user.type(editor, "# 主角\n\n新内容。\n");
    await user.click(screen.getByRole("button", { name: "预览保存" }));

    await waitFor(() =>
      expect(mocks.previewDocumentEdit).toHaveBeenCalledWith(
        "10_圣经/人物/主角.md",
        "# 主角\n\n新内容。\n",
        "hash-old",
      ),
    );
    expect(screen.getByText("保存文档预览")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "确认写入" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

describe("DocumentsPage", () => {
  it("目录收起时保留组件库的过渡内容，并阻止访问隐藏分支", async () => {
    const user = userEvent.setup();
    const filePath = "10_圣经/人物/主角.md";
    const capabilities = {
      readable: true,
      creatable: false,
      editable: false,
      archivable: false,
    };
    mocks.documentTree.mockResolvedValue([
      {
        kind: "directory",
        name: "圣经",
        path: "10_圣经",
        authority: "bible",
        capabilities,
        children: [
          {
            kind: "directory",
            name: "人物",
            path: "10_圣经/人物",
            authority: "bible",
            capabilities,
            children: [
              {
                kind: "file",
                name: "主角.md",
                path: filePath,
                authority: "bible",
                capabilities,
              },
            ],
          },
        ],
      },
    ]);
    const router = createMemoryRouter(
      [{ path: "/documents", Component: DocumentsPage }],
      { initialEntries: ["/documents"] },
    );
    render(<RouterProvider router={router} />);

    const parent = await screen.findByRole("button", { name: "圣经" });
    const child = screen.getByRole("button", { name: "人物" });
    const file = screen.getByRole("link", { name: /主角\.md/ });
    const branch = document.getElementById(
      parent.getAttribute("aria-controls")!,
    );
    expect(branch?.getAttribute("data-state")).toBe("open");
    expect(file.getAttribute("href")).toBe(
      `/documents/view?path=${encodeURIComponent(filePath)}`,
    );

    await user.click(parent);
    expect(parent.getAttribute("aria-expanded")).toBe("false");
    expect(branch?.getAttribute("data-state")).toBe("closed");
    expect(branch?.hasAttribute("inert")).toBe(true);
    expect(branch?.contains(file)).toBe(true);
    expect(screen.queryByRole("link", { name: /主角\.md/ })).toBeNull();

    await user.keyboard("{Enter}");
    expect(branch?.getAttribute("data-state")).toBe("open");
    expect(branch?.hasAttribute("inert")).toBe(false);

    await user.click(child);
    await user.click(parent);
    await user.click(parent);
    expect(parent.getAttribute("aria-expanded")).toBe("true");
    expect(child.getAttribute("aria-expanded")).toBe("false");
  });

  it("搜索结果提供带编码仓库相对路径的只读详情链接", async () => {
    const user = userEvent.setup();
    mocks.documents.mockResolvedValue([
      {
        path: "10_圣经/人物/主角.md",
        title: "主角",
        authority: "bible",
      },
    ]);
    const router = createMemoryRouter(
      [{ path: "/documents", Component: DocumentsPage }],
      { initialEntries: ["/documents"] },
    );
    render(<RouterProvider router={router} />);

    await user.click(screen.getByRole("button", { name: "搜索" }));
    const link = await screen.findByRole("link", { name: "阅读文档" });
    expect(link.getAttribute("href")).toBe(
      "/documents/view?path=10_%E5%9C%A3%E7%BB%8F%2F%E4%BA%BA%E7%89%A9%2F%E4%B8%BB%E8%A7%92.md",
    );
  });
});
