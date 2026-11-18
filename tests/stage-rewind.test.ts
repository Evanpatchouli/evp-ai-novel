import { access, readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { FinalConfirmation } from "../shared/contracts.js";
import { createSecuredTestApp } from "./helpers/secured-app.js";
import {
  buildContextPackage,
  commitWrite,
  confirmFinal,
  createTask,
  getIssues,
  getTask,
  importReview,
  importRevision,
  previewWrite,
  recordDecisions,
  rewindTaskStage,
  saveHumanFinal,
} from "../server/tasks.js";
import type { RepositoryFixture } from "./helpers/repository-fixture.js";
import { createRepositoryFixture } from "./helpers/repository-fixture.js";

const fixtures: RepositoryFixture[] = [];
const selectedPaths = ["40_正文/卷/v01/章节/ch002.md"];
const completeConfirmation: FinalConfirmation = {
  fullyRead: true,
  plotAndCharacterApproved: true,
  noUnauthorizedCanon: true,
  continuityApproved: true,
  willingToFinalize: true,
};

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function taskAtReviewImported(fixture: RepositoryFixture) {
  const task = await createTask(fixture.root, "v01", "ch002");
  await buildContextPackage(fixture.root, task.id, selectedPaths);
  await importReview(fixture.root, task.id, "## 重要问题\n- 修正表述\n");
  return task;
}

async function taskAtWritten(fixture: RepositoryFixture) {
  const { task, preview } = await taskAtReadyToWrite(fixture);
  await commitWrite(fixture.root, task.id, preview.token, true);
  return task;
}

async function taskAtReadyToWrite(fixture: RepositoryFixture) {
  const task = await taskAtReviewImported(fixture);
  const issues = await getIssues(fixture.root, task.id);
  await recordDecisions(fixture.root, task.id, [
    { id: issues[0]!.id, decision: "approved" },
  ]);
  const finalContent = "# 第二章 待验收\n\n安全回退测试终稿。\n";
  await importRevision(fixture.root, task.id, finalContent);
  await saveHumanFinal(fixture.root, task.id, finalContent);
  await confirmFinal(fixture.root, task.id, completeConfirmation);
  const preview = await previewWrite(fixture.root, task.id);
  return { task, preview };
}

describe("任务阶段安全回退", () => {
  it("review-imported 回退 context-ready 时归档 03 及后续工件并保留 02 与上下文选择", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const task = await taskAtReviewImported(fixture);

    const rewound = await rewindTaskStage(
      fixture.root,
      task.id,
      "context-ready",
    );

    expect(rewound).toMatchObject({
      stage: "context-ready",
      pendingDecisionCount: 0,
      selectedContextPaths: selectedPaths,
    });
    const taskDirectory = path.join(fixture.root, task.directory);
    await expect(
      access(path.join(taskDirectory, "02_ChatGPT审查上下文.zip")),
    ).resolves.toBeUndefined();
    await expect(
      access(path.join(taskDirectory, "02_审查提示词.md")),
    ).resolves.toBeUndefined();
    await expect(
      access(path.join(taskDirectory, "03_审稿报告_原文.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(path.join(taskDirectory, "03_审稿问题.yaml")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const historyRoot = path.join(taskDirectory, "history");
    const [rewindDirectory] = await readdir(historyRoot);
    expect(rewindDirectory).toMatch(/^rewind-/);
    expect(
      (await readdir(path.join(historyRoot, rewindDirectory!))).sort(),
    ).toEqual(["03_审稿报告_原文.md", "03_审稿问题.yaml"]);
  });

  it("拒绝同阶段、前跳以及 written 阶段回退", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const task = await taskAtReviewImported(fixture);

    await expect(
      rewindTaskStage(fixture.root, task.id, "review-imported"),
    ).rejects.toMatchObject({ code: "INVALID_STAGE_REWIND" });
    await expect(
      rewindTaskStage(fixture.root, task.id, "revision-imported"),
    ).rejects.toMatchObject({ code: "INVALID_STAGE_REWIND" });
    const writtenTask = await taskAtWritten(await createAndTrackFixture());
    await expect(
      rewindTaskStage(fixtures.at(-1)!.root, writtenTask.id, "context-ready"),
    ).rejects.toMatchObject({ code: "INVALID_STAGE_REWIND" });
  });

  it("PUT stage 返回回退后的 taskDetail", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const task = await taskAtReviewImported(fixture);

    const secured = await createSecuredTestApp(fixture.root);
    const response = await request(secured.app)
      .put(`/api/tasks/${task.id}/stage`)
      .set("Origin", secured.origin)
      .set("X-Workbench-Session", secured.sessionToken)
      .send({ stage: "context-ready" });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      id: task.id,
      stage: "context-ready",
      issues: [],
    });
    expect(response.body.data.reviewRaw).toBeUndefined();
    expect((await getTask(fixture.root, task.id)).stage).toBe("context-ready");
  });

  it("回退会清除终稿确认并使旧写入预览失效", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const { task, preview } = await taskAtReadyToWrite(fixture);

    const rewound = await rewindTaskStage(
      fixture.root,
      task.id,
      "human-final-review",
    );

    expect(rewound).toMatchObject({
      stage: "human-final-review",
      pendingDecisionCount: 0,
    });
    expect(rewound.finalConfirmation).toBeUndefined();
    await expect(
      commitWrite(fixture.root, task.id, preview.token, true),
    ).rejects.toMatchObject({ code: "INVALID_PREVIEW_TOKEN" });
    expect(await fixture.readChapter()).toBe(fixture.originalChapter);
  });
});

async function createAndTrackFixture(): Promise<RepositoryFixture> {
  const fixture = await createRepositoryFixture();
  fixtures.push(fixture);
  return fixture;
}
