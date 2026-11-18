import { readFile } from "node:fs/promises";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import type { RepositoryFixture } from "./helpers/repository-fixture.js";
import { createRepositoryFixture } from "./helpers/repository-fixture.js";
import { createSecuredTestApp } from "./helpers/secured-app.js";

const fixtures: RepositoryFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function setup() {
  const fixture = await createRepositoryFixture();
  fixtures.push(fixture);
  return { fixture, ...(await createSecuredTestApp(fixture.root)) };
}

function secured(
  app: Parameters<typeof request>[0],
  origin: string,
  sessionToken: string,
) {
  return {
    post: (path: string) =>
      request(app)
        .post(path)
        .set("Origin", origin)
        .set("X-Workbench-Session", sessionToken),
    put: (path: string) =>
      request(app)
        .put(path)
        .set("Origin", origin)
        .set("X-Workbench-Session", sessionToken),
  };
}

describe("章节 mutation API", () => {
  it("删除章节提交后更新卷状态表，且不生成回收记录", async () => {
    const { fixture, app, origin, sessionToken } = await setup();
    const write = secured(app, origin, sessionToken);
    const chapterUrl = "/api/volumes/v01/chapters/ch003";
    const chapter = await request(app).get(chapterUrl);
    const preview = await write
      .post(`${chapterUrl}/delete/preview`)
      .send({ expectedHash: chapter.body.data.sourceHash });
    expect(preview.status).toBe(200);
    expect(preview.body.data).toMatchObject({
      kind: "delete",
      confirmationRequirements: expect.arrayContaining([
        "confirm-chapter-delete",
      ]),
    });
    expect((await request(app).get(chapterUrl)).status).toBe(200);
    const result = await write
      .post(`/api/mutations/${preview.body.data.token}/commit`)
      .send({
        confirmed: true,
        confirmationKeys: preview.body.data.confirmationRequirements,
      });
    expect(result.status).toBe(200);
    expect((await request(app).get(chapterUrl)).status).toBe(404);
    expect(await fixture.readStatus()).toContain("chapter_count: 2");
    expect(
      (await request(app).get("/api/archives/chapters")).body.data,
    ).toEqual([]);
    expect(
      (await request(app).get("/api/volumes/v01/chapters/new")).body.data
        .chapterId,
    ).toBe("ch004");
  });
  it("返回卷末新章默认值，并只在完整确认后创建正文与状态", async () => {
    const { fixture, app, origin, sessionToken } = await setup();
    const write = secured(app, origin, sessionToken);

    const defaults = await request(app).get("/api/volumes/v01/chapters/new");
    expect(defaults.status).toBe(200);
    expect(defaults.body.data).toMatchObject({
      volumeId: "v01",
      chapterId: "ch004",
    });

    const preview = await write
      .post("/api/volumes/v01/chapters/preview")
      .send({ content: "# 第四章 API 新章\n\n正文。\n" });
    expect(preview.status).toBe(200);
    expect(preview.body.data.destinationHref).toBe(
      "/chapters/volumes/v01/chapters/ch004",
    );
    expect(preview.body.data.confirmationRequirements).toEqual([
      "confirm-content-write",
      "confirm-status-update",
    ]);

    const commit = await write
      .post(`/api/mutations/${preview.body.data.token}/commit`)
      .send({
        confirmed: true,
        confirmationKeys: preview.body.data.confirmationRequirements,
      });
    expect(commit.status).toBe(200);
    expect(commit.body.data).toMatchObject({
      kind: "create",
      chapterId: "ch004",
      destinationHref: "/chapters/volumes/v01/chapters/ch004",
      chapter: { title: "第四章 API 新章" },
    });
    expect(
      await readFile(`${fixture.root}/40_正文/卷/v01/章节/ch004.md`, "utf8"),
    ).toBe("# 第四章 API 新章\n\n正文。\n");
  });

  it("拒绝遗漏确认项，且一次性预览令牌不能重放", async () => {
    const { app, origin, sessionToken } = await setup();
    const write = secured(app, origin, sessionToken);
    const preview = await write
      .put("/api/volumes/v01/chapters/ch002/preview")
      .send({
        content: "# 第二章 API 修订\n\n正文。\n",
        expectedHash: "0".repeat(64),
      });
    expect(preview.status).toBe(409);
    expect(preview.body.error.code).toBe("SOURCE_CHANGED");

    const chapter = await request(app).get("/api/volumes/v01/chapters/ch002");
    const validPreview = await write
      .put("/api/volumes/v01/chapters/ch002/preview")
      .send({
        content: "# 第二章 API 修订\n\n正文。\n",
        expectedHash: chapter.body.data.sourceHash,
      });
    const missing = await write
      .post(`/api/mutations/${validPreview.body.data.token}/commit`)
      .send({ confirmed: true, confirmationKeys: [] });
    expect(missing.status).toBe(409);
    expect(missing.body.error).toMatchObject({
      code: "MUTATION_CONFIRMATION_REQUIRED",
      details: { required: ["confirm-content-write"] },
    });

    const replay = await write
      .post(`/api/mutations/${validPreview.body.data.token}/commit`)
      .send({
        confirmed: true,
        confirmationKeys: validPreview.body.data.confirmationRequirements,
      });
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe("INVALID_PREVIEW_TOKEN");
  });
});
