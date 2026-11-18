/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import browserIllustration from "../../client/src/assets/broswer.svg";
import readDataIllustration from "../../client/src/assets/read-data.svg";
import uploadIllustration from "../../client/src/assets/upload.svg";

const automationMock = vi.hoisted(() => vi.fn());

vi.mock("../../client/src/api.js", () => ({
  api: { automation: automationMock },
}));

vi.mock("../../client/src/app/RepositorySession.js", () => ({
  useRepositorySession: () => ({
    dashboard: { repositoryRoot: "C:/novel" },
  }),
}));

vi.mock("../../client/src/components/layout.js", () => ({
  PageHeader: () => null,
  Panel: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("../../client/src/components/states.js", () => ({
  ErrorState: ({ message }: { message: string }) => <div>{message}</div>,
  LoadingState: ({ label }: { label: string }) => <div>{label}</div>,
}));

vi.mock("@ldkj/web-ui", () => ({
  Alert: () => null,
  Chip: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
}));

import { AutomationPage } from "../../client/src/features/automation/AutomationPage.js";

afterEach(() => {
  cleanup();
  automationMock.mockReset();
});

describe("AutomationPage", () => {
  it("为三项自动化能力显示对应插图", async () => {
    automationMock.mockResolvedValue({
      enabled: false,
      provider: "disabled",
      reason: "默认关闭",
      canOpenBrowser: false,
      canUploadFiles: false,
      canReadOutput: false,
    });

    render(<AutomationPage />);

    await waitFor(() => expect(automationMock).toHaveBeenCalledOnce());
    expect(
      screen
        .getByRole("img", { name: "打开浏览器能力示意图" })
        .getAttribute("src"),
    ).toBe(browserIllustration);
    expect(
      screen
        .getByRole("img", { name: "上传任务包能力示意图" })
        .getAttribute("src"),
    ).toBe(uploadIllustration);
    expect(
      screen
        .getByRole("img", { name: "读取页面输出能力示意图" })
        .getAttribute("src"),
    ).toBe(readDataIllustration);
  });
});
