import { afterEach, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import request from "supertest";
import { createApp } from "../server/app.js";
import type { RepositoryFixture } from "./helpers/repository-fixture.js";
import { createRepositoryFixture } from "./helpers/repository-fixture.js";

const fixtures: RepositoryFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

describe("只读仓库 API", () => {
  it("仪表盘返回健康报告，章节摘要不携带正文", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);

    const response = await request(createApp(fixture.root).callback()).get(
      "/api/dashboard",
    );

    expect(response.status).toBe(200);
    expect(response.body.data.health).toEqual({ healthy: true, issues: [] });
    expect(response.body.data.volumes[0].chapters[1]).not.toHaveProperty(
      "content",
    );
  });

  it("健康接口与单章延迟详情保持现有响应契约", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const app = createApp(fixture.root).callback();

    const [health, chapter] = await Promise.all([
      request(app).get("/api/repository/health"),
      request(app).get("/api/volumes/v01/chapters/ch002"),
    ]);

    expect(health.status).toBe(200);
    expect(health.body.data.healthy).toBe(true);
    expect(chapter.status).toBe(200);
    expect(chapter.body.data).toMatchObject({
      volumeId: "v01",
      chapterId: "ch002",
      title: "第二章 待验收",
      status: "ai-revised",
      content: "# 第二章 待验收\n\n这是输入正文。\n",
      volume: { id: "v01", number: 1, title: "测试卷" },
      previous: { chapterId: "ch001" },
      next: { chapterId: "ch003" },
    });
  });

  it("卷列表和卷详情返回完整只读资源契约", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const taskId = "v01-ch002-stage2-test";
    const taskDirectory = path.join(fixture.root, "30_生产", "active", taskId);
    await mkdir(taskDirectory, { recursive: true });
    await writeFile(
      path.join(taskDirectory, "task.yaml"),
      `id: ${taskId}
volumeId: v01
chapterId: ch002
stage: review-imported
createdAt: 2026-07-18T00:00:00.000Z
updatedAt: 2026-07-18T01:00:00.000Z
directory: 30_生产/active/${taskId}
nextAction: 处理审稿
pendingDecisionCount: 1
`,
      "utf8",
    );
    const app = createApp(fixture.root).callback();

    const [volumes, detail] = await Promise.all([
      request(app).get("/api/volumes"),
      request(app).get("/api/volumes/v01"),
    ]);

    expect(volumes.status).toBe(200);
    expect(volumes.body.data).toMatchObject({
      health: { healthy: true, issues: [] },
      currentVolumeId: "v01",
      currentChapterId: "ch002",
      volumes: [
        {
          id: "v01",
          number: 1,
          title: "测试卷",
          chapterCount: 3,
        },
      ],
    });
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({
      id: "v01",
      totalWordCount: expect.any(Number),
      statusCounts: { final: 1, "ai-revised": 2 },
      firstChapter: { chapterId: "ch001" },
      lastChapter: { chapterId: "ch003" },
      currentChapterId: "ch002",
      relatedRecords: [
        {
          kind: "production",
          path: `30_生产/active/${taskId}/task.yaml`,
          title: "ch002 修订任务",
        },
      ],
      healthIssues: [],
    });
  });

  it("未知章节返回稳定的 404", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);

    const response = await request(createApp(fixture.root).callback()).get(
      "/api/volumes/v01/chapters/ch999",
    );

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("CHAPTER_NOT_FOUND");
  });

  it("未知卷返回 VOLUME_NOT_FOUND，非法资源 ID 返回 INVALID_REQUEST", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const app = createApp(fixture.root).callback();

    const [missing, invalidVolume, invalidChapter] = await Promise.all([
      request(app).get("/api/volumes/v99"),
      request(app).get("/api/volumes/not-a-volume"),
      request(app).get("/api/volumes/v01/chapters/ch2"),
    ]);

    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("VOLUME_NOT_FOUND");
    expect(invalidVolume.status).toBe(400);
    expect(invalidVolume.body.error.code).toBe("INVALID_REQUEST");
    expect(invalidChapter.status).toBe(400);
    expect(invalidChapter.body.error.code).toBe("INVALID_REQUEST");
  });

  it("需要人工恢复时阻断写入但继续提供只读数据与阻断级健康告警", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    await mkdir(path.join(fixture.root, ".workbench"), { recursive: true });
    await writeFile(
      path.join(fixture.root, ".workbench", "recovery-required.yaml"),
      "schemaVersion: 1\nreason: test\n",
      "utf8",
    );
    const app = createApp(fixture.root).callback();

    const [serviceHealth, repositoryHealth, dashboard, chapter] =
      await Promise.all([
        request(app).get("/api/health"),
        request(app).get("/api/repository/health"),
        request(app).get("/api/dashboard"),
        request(app).get("/api/volumes/v01/chapters/ch002"),
      ]);

    expect(serviceHealth.status).toBe(200);
    expect(serviceHealth.body.data.recoveryRequired).toBe(true);
    expect(repositoryHealth.status).toBe(200);
    expect(repositoryHealth.body.data).toMatchObject({ healthy: false });
    expect(repositoryHealth.body.data.issues).toContainEqual(
      expect.objectContaining({
        code: "MUTATION_RECOVERY_REQUIRED",
        severity: "blocking",
      }),
    );
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.data.health.healthy).toBe(false);
    expect(chapter.status).toBe(200);
    expect(chapter.body.data.content).toBe(fixture.originalChapter);
  });
});
