import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { FinalConfirmation } from "../shared/contracts.js";
import type { RepositoryFixture } from "./helpers/repository-fixture.js";
import { createRepositoryFixture } from "./helpers/repository-fixture.js";
import {
  buildContextPackage,
  commitWrite,
  confirmFinal,
  createTask,
  importReview,
  importRevision,
  previewWrite,
  recordDecisions,
  saveHumanFinal,
} from "../server/tasks.js";

const fixtures: RepositoryFixture[] = [];
const confirmation: FinalConfirmation = {
  fullyRead: true,
  plotAndCharacterApproved: true,
  noUnauthorizedCanon: true,
  continuityApproved: true,
  willingToFinalize: true,
};

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function readyTask(fixture: RepositoryFixture) {
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
  const content = "# 第二章 待验收\n\n并发验收终稿。\n";
  await importRevision(fixture.root, task.id, content);
  await saveHumanFinal(fixture.root, task.id, content);
  await confirmFinal(fixture.root, task.id, confirmation);
  return { task, content };
}

describe("终稿预览并发与外部冲突", () => {
  it("两个标签页各自预览时只允许先提交者写入", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const { task, content } = await readyTask(fixture);
    const first = await previewWrite(fixture.root, task.id);
    const second = await previewWrite(fixture.root, task.id);

    await commitWrite(fixture.root, task.id, first.token, true);
    await expect(
      commitWrite(fixture.root, task.id, second.token, true),
    ).rejects.toMatchObject({ code: "SOURCE_CHANGED" });

    expect(await fixture.readChapter()).toBe(content);
  });

  it("预览后正文被外部编辑时拒绝覆盖并保留外部内容", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const { task } = await readyTask(fixture);
    const preview = await previewWrite(fixture.root, task.id);
    const externalContent = "# 第二章 外部编辑\n\n由其他编辑器写入。\n";
    await writeFile(fixture.chapterPath, externalContent, "utf8");

    await expect(
      commitWrite(fixture.root, task.id, preview.token, true),
    ).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(await fixture.readChapter()).toBe(externalContent);
  });
});
