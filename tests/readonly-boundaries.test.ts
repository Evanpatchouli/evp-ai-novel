import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { RepositoryFixture } from "./helpers/repository-fixture.js";
import { createRepositoryFixture } from "./helpers/repository-fixture.js";
import { browserAutomation } from "../server/automation.js";
import { getGitStatus } from "../server/git.js";

const exec = promisify(execFile);
const fixtures: RepositoryFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function git(root: string, ...args: string[]): Promise<string> {
  const result = await exec("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  return result.stdout.trim();
}

describe("Git 只读边界", () => {
  it("读取状态不会改变 HEAD、索引或工作区", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    await git(fixture.root, "init");
    await git(fixture.root, "add", ".");
    await git(
      fixture.root,
      "-c",
      "user.name=Workbench Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "fixture",
    );
    await writeFileForGitTest(fixture);
    const beforeHead = await git(fixture.root, "rev-parse", "HEAD");
    const beforeStatus = await git(
      fixture.root,
      "status",
      "--porcelain=v1",
      "-uall",
    );

    const summary = await getGitStatus(fixture.root);

    expect(summary.changes).toHaveLength(1);
    expect(await git(fixture.root, "rev-parse", "HEAD")).toBe(beforeHead);
    expect(await git(fixture.root, "status", "--porcelain=v1", "-uall")).toBe(
      beforeStatus,
    );
    expect(summary.suggestedCommands).not.toContain("git push");
  });
});

async function writeFileForGitTest(fixture: RepositoryFixture): Promise<void> {
  const { appendFile } = await import("node:fs/promises");
  await appendFile(fixture.chapterPath, "\n未提交修改\n", "utf8");
}

describe("浏览器自动化边界", () => {
  it("保留 Provider 接口但默认完全关闭", () => {
    expect(browserAutomation.capabilities()).toEqual(
      expect.objectContaining({
        provider: "disabled",
        enabled: false,
        canOpenBrowser: false,
        canUploadFiles: false,
        canReadOutput: false,
      }),
    );
  });
});
