/** @vitest-environment jsdom */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createMemoryRouter,
  RouterProvider,
  type RouteObject,
} from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterDetail } from "../../shared/contracts.js";

const mocks = vi.hoisted(() => ({
  chapter: vi.fn(),
  tasks: vi.fn(),
  createTask: vi.fn(),
  open: vi.fn(),
  previewChapterEdit: vi.fn(),
  setTask: vi.fn(),
  showNotice: vi.fn(),
  clipboardWriteText: vi.fn(),
}));

vi.mock("../../client/src/api.js", () => ({
  ApiRequestError: class ApiRequestError extends Error {
    constructor(
      message: string,
      readonly code: string,
    ) {
      super(message);
    }
  },
  api: {
    chapter: mocks.chapter,
    tasks: mocks.tasks,
    createTask: mocks.createTask,
    open: mocks.open,
    previewChapterEdit: mocks.previewChapterEdit,
  },
}));

vi.mock("../../client/src/app/RepositorySession.js", () => ({
  useRepositorySession: () => ({
    setTask: mocks.setTask,
    showNotice: mocks.showNotice,
  }),
}));

import { ChapterDetailPage } from "../../client/src/features/chapters/ChapterDetailPage.js";
import { PageQuickActionsProvider } from "../../client/src/app/PageQuickActionsContext.js";
import { UnsavedChangesProvider } from "../../client/src/app/UnsavedChangesContext.js";
import { GlobalQuickActions } from "../../client/src/components/GlobalQuickActions.js";
import {
  chapterDetailHref,
  stripLeadingChapterH1,
} from "../../client/src/features/chapters/chapterNavigation.js";

function chapter(overrides: Partial<ChapterDetail> = {}): ChapterDetail {
  return {
    id: "ch001",
    number: 1,
    title: "第一章 山门",
    path: "40_正文/卷/v01/章节/ch001.md",
    status: "final",
    humanApproved: true,
    wordCount: 1280,
    lengthFlag: "normal",
    modifiedAt: "2026-07-18T02:30:00.000Z",
    volumeId: "v01",
    chapterId: "ch001",
    volume: { id: "v01", number: 1, title: "长青少年" },
    content:
      "# 第一章 山门\n\n正文段落。\n\n**强调内容**\n\n> 引用内容\n\n---\n\n- 列表内容\n\n[危险链接](javascript:alert(1))\n\n<img src=x onerror=alert(1)>\n",
    sourceHash: "a".repeat(64),
    next: {
      volumeId: "v02",
      volumeNumber: 2,
      chapterId: "ch002",
      chapterNumber: 2,
      title: "第二卷首章",
    },
    healthIssues: [],
    ...overrides,
  };
}

const routes: RouteObject[] = [
  {
    path: "/chapters/volumes/:volumeId/chapters/:chapterId",
    element: (
      <UnsavedChangesProvider>
        <PageQuickActionsProvider>
          <ChapterDetailPage />
          <GlobalQuickActions reloadPage={vi.fn()} scrollToTop={vi.fn()} />
        </PageQuickActionsProvider>
      </UnsavedChangesProvider>
    ),
  },
  { path: "/workflow/:taskId", element: <div>已进入任务</div> },
];

afterEach(() => {
  cleanup();
  Object.values(mocks).forEach((mock) => mock.mockReset());
});

beforeEach(() => {
  mocks.tasks.mockResolvedValue([]);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: mocks.clipboardWriteText },
  });
});

describe("章节阅读展示纯函数", () => {
  it("只移除开头的首个 H1，保留正文中的后续 H1", () => {
    expect(
      stripLeadingChapterH1("# 权威标题\n\n正文\n\n# 场景标题\n内容"),
    ).toBe("正文\n\n# 场景标题\n内容");
    expect(stripLeadingChapterH1("引子\n# 正文中的 H1\n")).toBe(
      "引子\n# 正文中的 H1\n",
    );
    expect(stripLeadingChapterH1("## 二级标题\n")).toBe("## 二级标题\n");
  });

  it("按服务端返回的卷章 ID 构造跨卷深链接", () => {
    expect(
      chapterDetailHref({
        volumeId: "v02",
        volumeNumber: 2,
        chapterId: "ch105",
        chapterNumber: 105,
        title: "新卷首章",
      }),
    ).toBe("/chapters/volumes/v02/chapters/ch105");
  });
});

describe("ChapterDetailPage", () => {
  it("非终稿章节默认只显示阅读预览", async () => {
    mocks.chapter.mockResolvedValue(
      chapter({
        status: "draft",
        humanApproved: false,
        sourceHash: "b".repeat(64),
      }),
    );
    const router = createMemoryRouter(routes, {
      initialEntries: ["/chapters/volumes/v01/chapters/ch001"],
    });

    render(<RouterProvider router={router} />);

    expect(await screen.findByText("正文段落。")).toBeTruthy();
    expect(
      screen.queryByRole("textbox", { name: "章节 Markdown 原文" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "页面快捷操作" }));
    expect(
      await screen.findByRole("button", { name: "编辑章节" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "复制源 Markdown" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "快捷保存" })).toBeNull();
  });

  it("阅读态复制磁盘源 Markdown 并删除所有空白行", async () => {
    mocks.chapter.mockResolvedValue(
      chapter({
        content:
          "# 第一章 山门\n\n正文段落。\n \t \n**强调内容**\n\n> 引用内容\n",
      }),
    );
    const router = createMemoryRouter(routes, {
      initialEntries: ["/chapters/volumes/v01/chapters/ch001"],
    });
    render(<RouterProvider router={router} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "页面快捷操作" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "复制源 Markdown" }),
    );

    await waitFor(() =>
      expect(mocks.clipboardWriteText).toHaveBeenCalledWith(
        "# 第一章 山门\n正文段落。\n**强调内容**\n> 引用内容",
      ),
    );
    expect(mocks.showNotice).toHaveBeenCalledWith({
      tone: "success",
      message: "章节源 Markdown（已去除空行）已复制到剪贴板。",
    });
  });

  it("剪贴板拒绝复制时显示错误通知", async () => {
    mocks.chapter.mockResolvedValue(chapter());
    mocks.clipboardWriteText.mockRejectedValue(new Error("NotAllowedError"));
    const router = createMemoryRouter(routes, {
      initialEntries: ["/chapters/volumes/v01/chapters/ch001"],
    });
    render(<RouterProvider router={router} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "页面快捷操作" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "复制源 Markdown" }),
    );

    await waitFor(() =>
      expect(mocks.showNotice).toHaveBeenCalledWith({
        tone: "error",
        message: "浏览器拒绝访问剪贴板，请手动复制章节源 Markdown。",
      }),
    );
  });

  it("通过页面快捷操作切换模式、保留草稿并打开保存预览", async () => {
    mocks.chapter.mockResolvedValue(
      chapter({
        status: "draft",
        humanApproved: false,
        sourceHash: "b".repeat(64),
      }),
    );
    mocks.previewChapterEdit.mockResolvedValue({
      kind: "edit",
      token: "preview-token",
      targetPath: "40_正文/卷/v01/章节/ch001.md",
      diff: [{ type: "added", value: "本地草稿" }],
      confirmationRequirements: [],
    });
    const router = createMemoryRouter(routes, {
      initialEntries: ["/chapters/volumes/v01/chapters/ch001"],
    });
    render(<RouterProvider router={router} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "页面快捷操作" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "编辑章节" }));
    const editor = await screen.findByRole("textbox", {
      name: "章节 Markdown 原文",
    });
    expect(
      (await screen.findByRole("button", {
        name: "快捷保存",
      })) as HTMLButtonElement,
    ).toMatchObject({ disabled: true });
    expect(
      screen.queryByRole("button", { name: "复制源 Markdown" }),
    ).toBeNull();

    fireEvent.change(editor, {
      target: { value: "# 第一章 本地草稿\n\n尚未写入的内容。\n" },
    });
    expect(
      screen.getByRole("button", { name: "快捷保存" }) as HTMLButtonElement,
    ).toMatchObject({ disabled: false });

    fireEvent.click(screen.getByRole("button", { name: "预览章节" }));
    expect(
      screen.queryByRole("textbox", { name: "章节 Markdown 原文" }),
    ).toBeNull();
    expect(screen.getByText("尚未写入的内容。")).toBeTruthy();
    expect(screen.getByText("当前预览包含未保存修改")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "快捷保存" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "页面快捷操作" }));
    fireEvent.click(screen.getByRole("button", { name: "编辑章节" }));
    expect(
      (
        (await screen.findByRole("textbox", {
          name: "章节 Markdown 原文",
        })) as HTMLTextAreaElement
      ).value,
    ).toContain("尚未写入的内容");

    fireEvent.click(screen.getByRole("button", { name: "页面快捷操作" }));
    fireEvent.click(await screen.findByRole("button", { name: "快捷保存" }));
    await waitFor(() =>
      expect(mocks.previewChapterEdit).toHaveBeenCalledWith(
        "v01",
        "ch001",
        "# 第一章 本地草稿\n\n尚未写入的内容。\n",
        "b".repeat(64),
      ),
    );
    expect(
      await screen.findByRole("heading", { name: "保存章节预览" }),
    ).toBeTruthy();
  });

  it("默认安全阅读并使用服务端跨卷导航，终稿只能显式开启新修订", async () => {
    const user = userEvent.setup();
    mocks.chapter.mockResolvedValue(chapter());
    mocks.createTask.mockResolvedValue({ id: "task-final-revision" });
    const router = createMemoryRouter(routes, {
      initialEntries: ["/chapters/volumes/v01/chapters/ch001"],
    });

    render(<RouterProvider router={router} />);

    expect(
      await screen.findByRole("heading", { name: "第一章 山门" }),
    ).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByText("正文段落。")).toBeTruthy();
    expect(screen.getByText("强调内容").tagName).toBe("STRONG");
    expect(screen.getByText("引用内容").closest("blockquote")).toBeTruthy();
    expect(screen.getByText("列表内容").closest("li")).toBeTruthy();
    expect(document.querySelector("hr")).toBeTruthy();
    expect(document.querySelector("img[src='x']")).toBeNull();
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "编辑章节" })).toBeNull();
    expect(screen.queryByRole("button", { name: "快捷保存" })).toBeNull();
    expect(
      screen
        .getAllByRole("link", { name: /下一章\s*第二卷首章/ })
        .every(
          (link) => link.getAttribute("href") === "/chapters/volumes/v02/chapters/ch002",
        ),
    ).toBe(true);
    expect(
      screen
        .getAllByRole("link", { name: "返回《长青少年》" })
        .every((link) => link.getAttribute("href") === "/chapters/volumes/v01"),
    ).toBe(true);

    await user.click(
      screen.getByRole("button", { name: "为终稿创建新一轮修订" }),
    );
    expect(mocks.createTask).toHaveBeenCalledWith("v01", "ch001", true);
    expect(mocks.setTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-final-revision" }),
    );
    expect(await screen.findByText("已进入任务")).toBeTruthy();
  });

  it("同章已有未归档任务时直接继续且不重复创建", async () => {
    const user = userEvent.setup();
    mocks.chapter.mockResolvedValue(chapter());
    mocks.tasks.mockResolvedValue([
      {
        id: "task-existing",
        volumeId: "v01",
        chapterId: "ch001",
        stage: "review-imported",
      },
    ]);
    const router = createMemoryRouter(routes, {
      initialEntries: ["/chapters/volumes/v01/chapters/ch001"],
    });

    render(<RouterProvider router={router} />);

    await user.click(
      await screen.findByRole("button", { name: "继续现有验收任务" }),
    );
    expect(mocks.createTask).not.toHaveBeenCalled();
    expect(await screen.findByText("已进入任务")).toBeTruthy();
  });

  it("路由快速切换时忽略较晚返回的旧章节", async () => {
    let resolveOld!: (value: ChapterDetail) => void;
    const oldRequest = new Promise<ChapterDetail>((resolve) => {
      resolveOld = resolve;
    });
    mocks.chapter.mockImplementation((_volumeId: string, chapterId: string) =>
      chapterId === "ch001"
        ? oldRequest
        : Promise.resolve(
            chapter({
              id: "ch002",
              number: 2,
              chapterId: "ch002",
              title: "第二章 新响应",
              content: "# 第二章 新响应\n\n新正文。\n",
            }),
          ),
    );
    const router = createMemoryRouter(routes, {
      initialEntries: ["/chapters/volumes/v01/chapters/ch001"],
    });
    render(<RouterProvider router={router} />);
    await waitFor(() =>
      expect(mocks.chapter).toHaveBeenCalledWith("v01", "ch001"),
    );

    await router.navigate("/chapters/volumes/v01/chapters/ch002");
    expect(
      await screen.findByRole("heading", { name: "第二章 新响应" }),
    ).toBeTruthy();
    resolveOld(chapter());

    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "第一章 山门" })).toBeNull(),
    );
    expect(screen.getByText("新正文。")).toBeTruthy();
  });

  it("保存预览冲突时保留内存草稿与编辑器", async () => {
    const user = userEvent.setup();
    mocks.chapter.mockResolvedValue(
      chapter({
        status: "draft",
        humanApproved: false,
        sourceHash: "b".repeat(64),
      }),
    );
    mocks.previewChapterEdit.mockRejectedValue(
      new Error("章节已被外部修改，请重新读取后再预览"),
    );
    const router = createMemoryRouter(routes, {
      initialEntries: ["/chapters/volumes/v01/chapters/ch001"],
    });
    render(<RouterProvider router={router} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "页面快捷操作" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "编辑章节" }));
    const editor = await screen.findByRole("textbox", {
      name: "章节 Markdown 原文",
    });
    await user.clear(editor);
    await user.type(editor, "# 第一章 本地草稿\n\n保留内容。\n");
    await user.click(screen.getByRole("button", { name: "预览保存" }));

    expect(
      await screen.findByText("章节已被外部修改，请重新读取后再预览"),
    ).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "章节 Markdown 原文" })).toBe(
      editor,
    );
    expect((editor as HTMLTextAreaElement).value).toContain("保留内容");
  });
});
