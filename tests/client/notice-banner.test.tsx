/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoticeBanner } from "../../client/src/components/NoticeBanner.js";

afterEach(cleanup);

describe("NoticeBanner", () => {
  it("在任务包生成提示中展示下载和打开文件夹操作", () => {
    const openFolder = vi.fn();

    render(
      <NoticeBanner
        notice={{
          tone: "success",
          message: "任务包已生成：30_生产/active/task/context.zip",
          actions: [
            {
              kind: "link",
              label: "下载任务包",
              href: "/api/tasks/task-1/context-package/download",
              download: true,
            },
            {
              kind: "button",
              label: "打开文件夹",
              onClick: openFolder,
            },
          ],
        }}
        onClose={() => undefined}
      />,
    );

    const download = screen.getByRole("link", { name: "下载任务包" });
    expect(download.getAttribute("href")).toBe(
      "/api/tasks/task-1/context-package/download",
    );
    expect(download.hasAttribute("download")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "打开文件夹" }));
    expect(openFolder).toHaveBeenCalledOnce();
  });
});
