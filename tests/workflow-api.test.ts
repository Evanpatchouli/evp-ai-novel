import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import request, { type Test } from "supertest";
import type { FinalConfirmation } from "../shared/contracts.js";
import type { RepositoryFixture } from "./helpers/repository-fixture.js";
import { createRepositoryFixture } from "./helpers/repository-fixture.js";
import { createSecuredTestApp } from "./helpers/secured-app.js";

const fixtures: RepositoryFixture[] = [];
const selectedPaths = [
  "10_圣经/核心/修订风格卡.md",
  "20_规划/卷/v01/修订上下文卡.md",
  "40_正文/卷/v01/章节/ch002.md",
  "10_圣经/人物/主角.md",
];
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

describe("受保护 HTTP 九阶段终稿流程", () => {
  it("从章节任务创建推进到正式写入和任务归档，并可在每个刷新点恢复", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const { app, origin, sessionToken } = await createSecuredTestApp(
      fixture.root,
    );
    const write = (test: Test) =>
      test.set("Origin", origin).set("X-Workbench-Session", sessionToken);
    const finalContent = "# 第二章 待验收\n\n这是九阶段 HTTP 验收终稿。\n";

    const created = await write(request(app).post("/api/tasks")).send({
      volumeId: "v01",
      chapterId: "ch002",
      allowFinalRevision: false,
    });
    expect(created.status).toBe(201);
    expect(created.body.data.stage).toBe("created");
    const taskId = created.body.data.id as string;
    expect(await fixture.readChapter()).toBe(fixture.originalChapter);

    const context = await write(
      request(app).post(`/api/tasks/${taskId}/context/build`),
    ).send({ selectedPaths });
    expect(context.status).toBe(200);
    expect(context.body.data.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: selectedPaths[0],
          selected: true,
        }),
        expect.objectContaining({
          path: selectedPaths[1],
          selected: true,
        }),
      ]),
    );
    expect(
      (await request(app).get(`/api/tasks/${taskId}`)).body.data,
    ).toMatchObject({
      stage: "context-ready",
      selectedContextPaths: selectedPaths,
    });
    expect(
      (await request(app).get(`/api/tasks/${taskId}/revision-package/download`))
        .status,
    ).toBe(404);
    expect(
      (
        await write(
          request(app).post(`/api/tasks/${taskId}/revision-package`),
        ).send()
      ).status,
    ).toBe(400);

    const review = await write(
      request(app).post(`/api/tasks/${taskId}/review`),
    ).send({ content: "## 重要问题\n- 修正一个表述问题\n" });
    expect(review.body.data).toMatchObject({
      stage: "review-imported",
      pendingDecisionCount: 1,
    });
    const issueId = review.body.data.issues[0].id as string;

    const decisions = await write(
      request(app).put(`/api/tasks/${taskId}/decisions`),
    ).send({
      decisions: [{ id: issueId, decision: "approved", decisionNote: "同意" }],
      revisionInstructionAdditions: [
        "根据写作规范，对通篇的文笔文风进行润色。",
      ],
    });
    expect(decisions.body.data).toMatchObject({
      stage: "decisions-recorded",
      pendingDecisionCount: 0,
    });
    expect(decisions.body.data.prompt).toContain(
      "根据写作规范，对通篇的文笔文风进行润色。",
    );

    const revisionPackage = await write(
      request(app).post(`/api/tasks/${taskId}/revision-package`),
    ).send();
    expect(revisionPackage.status).toBe(200);
    expect(revisionPackage.body.data.zipPath).toBe(
      `30_生产/active/${taskId}/04_AI修订上下文.zip`,
    );
    const revisionPackageDownload = await request(app).get(
      `/api/tasks/${taskId}/revision-package/download`,
    );
    expect(revisionPackageDownload.status).toBe(200);
    expect(revisionPackageDownload.headers["content-type"]).toContain(
      "application/zip",
    );
    expect(revisionPackageDownload.headers["content-disposition"]).toContain(
      `${taskId}-revision-context.zip`,
    );

    const compactPackage = await write(
      request(app).post(`/api/tasks/${taskId}/revision-package/compact`),
    ).send();
    expect(compactPackage.status).toBe(200);
    expect(compactPackage.body.data.zipPath).toBe(
      `30_生产/active/${taskId}/04_AI修订精简包.zip`,
    );
    const compactPackageDownload = await request(app).get(
      `/api/tasks/${taskId}/revision-package/compact/download`,
    );
    expect(compactPackageDownload.status).toBe(200);
    expect(compactPackageDownload.headers["content-type"]).toContain(
      "application/zip",
    );
    expect(compactPackageDownload.headers["content-disposition"]).toContain(
      `${taskId}-compact-revision-context.zip`,
    );

    const compactTextPackage = await write(
      request(app).post(`/api/tasks/${taskId}/revision-package/compact-text`),
    ).send();
    expect(compactTextPackage.status).toBe(200);
    expect(compactTextPackage.body.data.textPath).toBe(
      `30_生产/active/${taskId}/04_AI修订精简单文件.txt`,
    );
    const compactTextDownload = await request(app).get(
      `/api/tasks/${taskId}/revision-package/compact-text/download`,
    );
    expect(compactTextDownload.status).toBe(200);
    expect(compactTextDownload.headers["content-type"]).toContain("text/plain");
    expect(compactTextDownload.headers["content-disposition"]).toContain(
      `${taskId}-compact-revision-context.txt`,
    );

    const revision = await write(
      request(app).post(`/api/tasks/${taskId}/revision`),
    ).send({ content: finalContent });
    expect(revision.body.data.stage).toBe("revision-imported");

    const humanFinal = await write(
      request(app).put(`/api/tasks/${taskId}/human-final`),
    ).send({ content: finalContent });
    expect(humanFinal.status).toBe(200);
    expect(humanFinal.body.data).toMatchObject({
      stage: "human-final-review",
      revisionRaw: finalContent,
    });

    const confirmed = await write(
      request(app).post(`/api/tasks/${taskId}/final-confirmation`),
    ).send(confirmation);
    expect(confirmed.body.data).toMatchObject({
      stage: "ready-to-write",
      revisionRaw: finalContent,
      finalConfirmation: confirmation,
    });

    const preview = await write(
      request(app).post(`/api/tasks/${taskId}/write/preview`),
    ).send();
    expect(preview.status).toBe(200);
    expect(preview.body.data).toMatchObject({
      taskId,
      targetPath: "40_正文/卷/v01/章节/ch002.md",
      statusPath: "40_正文/卷/v01/状态.yaml",
    });
    expect(await fixture.readChapter()).toBe(fixture.originalChapter);

    const committed = await write(
      request(app).post(`/api/tasks/${taskId}/write/commit`),
    ).send({ token: preview.body.data.token });
    expect(committed.status).toBe(200);
    expect(committed.body.data.stage).toBe("written");
    expect(await fixture.readChapter()).toBe(finalContent);
    expect(await fixture.readStatus()).toMatch(
      /chapters: ch002[\s\S]*status: final[\s\S]*human_approved: true/,
    );

    const taskDirectory = committed.body.data.directory as string;
    await expect(
      access(path.join(fixture.root, taskDirectory, "07_写入记录.md")),
    ).resolves.toBeUndefined();

    const archived = await write(
      request(app).post(`/api/tasks/${taskId}/archive`),
    ).send();
    expect(archived.status).toBe(200);
    expect(archived.body.data).toMatchObject({
      stage: "archived",
      directory: `30_生产/archive/${taskId}`,
    });
    await expect(
      access(path.join(fixture.root, taskDirectory)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await readFile(
        path.join(fixture.root, "30_生产", "archive", taskId, "task.yaml"),
        "utf8",
      ),
    ).toMatch(/stage: archived/);
    expect(
      (await request(app).get(`/api/tasks/${taskId}`)).body.data.stage,
    ).toBe("archived");
  });
});
