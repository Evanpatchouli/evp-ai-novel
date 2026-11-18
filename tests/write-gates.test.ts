import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { FinalConfirmation } from "../shared/contracts.js";
import type { RepositoryFixture } from "./helpers/repository-fixture.js";
import { createRepositoryFixture } from "./helpers/repository-fixture.js";
import { atomicWrite } from "../server/files.js";
import { createSecuredTestApp } from "./helpers/secured-app.js";
import {
  buildContextPackage,
  commitWrite,
  confirmFinal,
  createTask,
  getTask,
  importReview,
  importRevision,
  previewWrite,
  recordDecisions,
  saveHumanFinal,
} from "../server/tasks.js";

const fixtures: RepositoryFixture[] = [];
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

async function taskAtHumanFinal(
  fixture: RepositoryFixture,
  finalContent: string,
) {
  const task = await createTask(fixture.root, "v01", "ch002");
  await buildContextPackage(fixture.root, task.id, [
    "40_正文/卷/v01/章节/ch002.md",
  ]);
  const issues = await importReview(
    fixture.root,
    task.id,
    "## 重要问题\n- 修正一个表述问题\n",
  );
  await recordDecisions(fixture.root, task.id, [
    { id: issues[0]!.id, decision: "approved" },
  ]);
  await importRevision(fixture.root, task.id, finalContent);
  await saveHumanFinal(fixture.root, task.id, finalContent);
  return task;
}

describe("人工终稿确认门槛", () => {
  it("五项确认缺少任意一项都不能进入写入阶段", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const task = await taskAtHumanFinal(
      fixture,
      "# 第二章 待验收\n\n这是作者终审稿。\n",
    );

    await expect(
      confirmFinal(fixture.root, task.id, {
        ...completeConfirmation,
        continuityApproved: false,
      }),
    ).rejects.toMatchObject({ code: "INCOMPLETE_FINAL_CONFIRMATION" });
    await expect(previewWrite(fixture.root, task.id)).rejects.toMatchObject({
      code: "NOT_READY_TO_WRITE",
    });
    expect(await fixture.readChapter()).toBe(fixture.originalChapter);
  });

  it("组合终审缺少确认时不保存终审稿也不推进阶段", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const task = await createTask(fixture.root, "v01", "ch002");
    await buildContextPackage(fixture.root, task.id, [
      "40_正文/卷/v01/章节/ch002.md",
    ]);
    const issues = await importReview(
      fixture.root,
      task.id,
      "## 重要问题\n- 修正一个表述问题\n",
    );
    await recordDecisions(fixture.root, task.id, [
      { id: issues[0]!.id, decision: "approved" },
    ]);
    await importRevision(
      fixture.root,
      task.id,
      "# 第二章 待验收\n\nAI 修订稿。\n",
    );
    const secured = await createSecuredTestApp(fixture.root);
    const response = await request(secured.app)
      .post(`/api/tasks/${task.id}/final-review`)
      .set("Origin", secured.origin)
      .set("X-Workbench-Session", secured.sessionToken)
      .send({
        content: "# 第二章 待验收\n\n不应落盘的人工终审稿。\n",
        confirmation: { ...completeConfirmation, continuityApproved: false },
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INCOMPLETE_FINAL_CONFIRMATION");
    await expect(
      readFile(
        path.join(fixture.root, task.directory, "06_人工终审稿.md"),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await getTask(fixture.root, task.id)).stage).toBe(
      "revision-imported",
    );
  });
});

describe("写入预览与事务边界", () => {
  it("拒绝使用其他任务的终稿预览令牌提交当前任务", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const taskA = await taskAtHumanFinal(
      fixture,
      "# 第二章 待验收\n\n任务 A 的作者确认终稿。\n",
    );
    await confirmFinal(fixture.root, taskA.id, completeConfirmation);
    const previewA = await previewWrite(fixture.root, taskA.id);
    const taskB = await createTask(fixture.root, "v01", "ch003");

    await expect(
      commitWrite(fixture.root, taskB.id, previewA.token, true),
    ).rejects.toMatchObject({ code: "INVALID_PREVIEW_TOKEN" });

    expect((await getTask(fixture.root, taskA.id)).stage).toBe(
      "ready-to-write",
    );
    expect((await getTask(fixture.root, taskB.id)).stage).toBe("created");
    expect(await fixture.readChapter()).toBe(fixture.originalChapter);
  });

  it("无 H1 的修订稿不能进入人工终审与正式写入", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);

    await expect(
      taskAtHumanFinal(fixture, "这份人工终审稿没有 Markdown H1。\n"),
    ).rejects.toMatchObject({ code: "INVALID_CHAPTER_CONTENT" });
    expect(await fixture.readChapter()).toBe(fixture.originalChapter);
  });

  it("正式写入预览会再次拒绝被外部替换成无 H1 的终审稿", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const task = await taskAtHumanFinal(
      fixture,
      "# 第二章 待验收\n\n合法的人工终审稿。\n",
    );
    await confirmFinal(fixture.root, task.id, completeConfirmation);
    await writeFile(
      path.join(fixture.root, task.directory, "06_人工终审稿.md"),
      "被外部替换成没有 H1 的终审稿。\n",
      "utf8",
    );

    await expect(previewWrite(fixture.root, task.id)).rejects.toMatchObject({
      code: "INVALID_CHAPTER_CONTENT",
    });
    expect((await getTask(fixture.root, task.id)).stage).toBe("ready-to-write");
    expect(await fixture.readChapter()).toBe(fixture.originalChapter);
  });

  it("预览不写正文，令牌校验哈希、禁止重放，并同时更新正文和状态", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const finalContent = "# 第二章 待验收\n\n这是作者确认后的终稿。\n";
    const task = await taskAtHumanFinal(fixture, finalContent);
    await confirmFinal(fixture.root, task.id, completeConfirmation);

    const conflictedPreview = await previewWrite(fixture.root, task.id);
    expect(await fixture.readChapter()).toBe(fixture.originalChapter);
    await writeFile(
      fixture.chapterPath,
      `${fixture.originalChapter}\n外部修改`,
      "utf8",
    );
    await expect(
      commitWrite(fixture.root, task.id, conflictedPreview.token, true),
    ).rejects.toMatchObject({ code: "SOURCE_CHANGED" });

    await writeFile(fixture.chapterPath, fixture.originalChapter, "utf8");
    const preview = await previewWrite(fixture.root, task.id);
    await expect(
      commitWrite(fixture.root, task.id, preview.token, false),
    ).rejects.toMatchObject({ code: "WRITE_CONFIRMATION_REQUIRED" });
    await commitWrite(fixture.root, task.id, preview.token, true);

    expect(await fixture.readChapter()).toBe(finalContent);
    expect(await readFile(fixture.statusPath, "utf8")).toMatch(
      /chapters: ch002[\s\S]*status: final[\s\S]*human_approved: true/,
    );
    await expect(
      commitWrite(fixture.root, task.id, preview.token, true),
    ).rejects.toMatchObject({ code: "INVALID_PREVIEW_TOKEN" });
  });

  it("单文件原子替换不遗留临时文件", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const target = path.join(fixture.root, "30_生产", "active", "atomic.md");

    await atomicWrite(target, "完整内容");

    expect(await readFile(target, "utf8")).toBe("完整内容");
    expect(
      (await readdir(path.dirname(target))).filter(
        (name) => name.includes("atomic.md") && name.endsWith(".tmp"),
      ),
    ).toEqual([]);
  });
});
