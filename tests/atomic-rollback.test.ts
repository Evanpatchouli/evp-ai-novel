import path from "node:path";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

const renameControl = vi.hoisted(() => ({
  failStatusInstall: false,
  failWriteRecord: false,
  failArchive: false,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: vi.fn(async (oldPath: string, newPath: string) => {
      if (renameControl.failWriteRecord && newPath.endsWith("07_写入记录.md")) {
        renameControl.failWriteRecord = false;
        throw new Error("模拟写入记录保存失败");
      }
      return actual.link(oldPath, newPath);
    }),
    rename: vi.fn(async (oldPath: string, newPath: string) => {
      if (
        renameControl.failStatusInstall &&
        oldPath.endsWith(".tmp") &&
        newPath.endsWith("状态.yaml")
      ) {
        renameControl.failStatusInstall = false;
        throw new Error("模拟状态文件安装失败");
      }
      if (
        renameControl.failArchive &&
        oldPath.includes(`${path.sep}30_生产${path.sep}active${path.sep}`) &&
        newPath.includes(`${path.sep}30_生产${path.sep}archive${path.sep}`)
      ) {
        renameControl.failArchive = false;
        throw new Error("模拟归档目录移动失败");
      }
      return actual.rename(oldPath, newPath);
    }),
  };
});

import type { RepositoryFixture } from "./helpers/repository-fixture.js";
import { createRepositoryFixture } from "./helpers/repository-fixture.js";
import {
  buildContextPackage,
  archiveTask,
  commitWrite,
  confirmFinal,
  createTask,
  importReview,
  importRevision,
  getTask,
  previewWrite,
  recordDecisions,
  saveHumanFinal,
} from "../server/tasks.js";

const fixtures: RepositoryFixture[] = [];

afterEach(async () => {
  renameControl.failStatusInstall = false;
  renameControl.failWriteRecord = false;
  renameControl.failArchive = false;
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

describe("双文件写入回滚", () => {
  it("状态文件安装失败时恢复正文和状态原件", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const statusBefore = await readFile(fixture.statusPath, "utf8");
    const finalContent = "# 第二章 待验收\n\n不会留下半写状态。\n";
    const task = await createTask(fixture.root, "v01", "ch002");
    await buildContextPackage(fixture.root, task.id, [
      "40_正文/卷/v01/章节/ch002.md",
    ]);
    const issues = await importReview(
      fixture.root,
      task.id,
      "## 重要问题\n- 修正表述\n",
    );
    await recordDecisions(fixture.root, task.id, [
      { id: issues[0]!.id, decision: "approved" },
    ]);
    await importRevision(fixture.root, task.id, finalContent);
    await saveHumanFinal(fixture.root, task.id, finalContent);
    await confirmFinal(fixture.root, task.id, {
      fullyRead: true,
      plotAndCharacterApproved: true,
      noUnauthorizedCanon: true,
      continuityApproved: true,
      willingToFinalize: true,
    });
    const preview = await previewWrite(fixture.root, task.id);
    renameControl.failStatusInstall = true;

    await expect(
      commitWrite(fixture.root, task.id, preview.token, true),
    ).rejects.toMatchObject({ code: "ATOMIC_WRITE_FAILED" });

    expect(await fixture.readChapter()).toBe(fixture.originalChapter);
    expect(await readFile(fixture.statusPath, "utf8")).toBe(statusBefore);
    const taskDirectory = path.join(fixture.root, task.directory);
    await expect(
      (await import("node:fs/promises")).readdir(taskDirectory),
    ).resolves.not.toContain("07_写入记录.md");
  });

  it("写入记录保存失败时恢复正文、状态和任务阶段", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const statusBefore = await readFile(fixture.statusPath, "utf8");
    const finalContent = "# 第二章 待验收\n\n后置记录失败也必须整体回滚。\n";
    const task = await createTask(fixture.root, "v01", "ch002");
    await buildContextPackage(fixture.root, task.id, [
      "40_正文/卷/v01/章节/ch002.md",
    ]);
    const issues = await importReview(
      fixture.root,
      task.id,
      "## 重要问题\n- 修正表述\n",
    );
    await recordDecisions(fixture.root, task.id, [
      { id: issues[0]!.id, decision: "approved" },
    ]);
    await importRevision(fixture.root, task.id, finalContent);
    await saveHumanFinal(fixture.root, task.id, finalContent);
    await confirmFinal(fixture.root, task.id, {
      fullyRead: true,
      plotAndCharacterApproved: true,
      noUnauthorizedCanon: true,
      continuityApproved: true,
      willingToFinalize: true,
    });
    const preview = await previewWrite(fixture.root, task.id);
    renameControl.failWriteRecord = true;

    await expect(
      commitWrite(fixture.root, task.id, preview.token, true),
    ).rejects.toMatchObject({ code: "ATOMIC_WRITE_FAILED" });

    expect(await fixture.readChapter()).toBe(fixture.originalChapter);
    expect(await readFile(fixture.statusPath, "utf8")).toBe(statusBefore);
    expect((await getTask(fixture.root, task.id)).stage).toBe("ready-to-write");
    const taskDirectory = path.join(fixture.root, task.directory);
    await expect(
      (await import("node:fs/promises")).readdir(taskDirectory),
    ).resolves.not.toContain("07_写入记录.md");
  });

  it("归档目录移动失败时 active 任务仍保持 written", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const finalContent = "# 第二章 待验收\n\n可归档终稿。\n";
    const task = await createTask(fixture.root, "v01", "ch002");
    await buildContextPackage(fixture.root, task.id, [
      "40_正文/卷/v01/章节/ch002.md",
    ]);
    const issues = await importReview(
      fixture.root,
      task.id,
      "## 重要问题\n- 修正表述\n",
    );
    await recordDecisions(fixture.root, task.id, [
      { id: issues[0]!.id, decision: "approved" },
    ]);
    await importRevision(fixture.root, task.id, finalContent);
    await saveHumanFinal(fixture.root, task.id, finalContent);
    await confirmFinal(fixture.root, task.id, {
      fullyRead: true,
      plotAndCharacterApproved: true,
      noUnauthorizedCanon: true,
      continuityApproved: true,
      willingToFinalize: true,
    });
    const preview = await previewWrite(fixture.root, task.id);
    await commitWrite(fixture.root, task.id, preview.token, true);
    renameControl.failArchive = true;

    await expect(archiveTask(fixture.root, task.id)).rejects.toThrow(
      "模拟归档目录移动失败",
    );

    const persisted = await getTask(fixture.root, task.id);
    expect(persisted).toMatchObject({
      stage: "written",
      directory: task.directory,
    });
  });
});
