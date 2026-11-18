import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
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
    post: (url: string) =>
      request(app)
        .post(url)
        .set("Origin", origin)
        .set("X-Workbench-Session", sessionToken),
    put: (url: string) =>
      request(app)
        .put(url)
        .set("Origin", origin)
        .set("X-Workbench-Session", sessionToken),
  };
}

async function commit(
  write: ReturnType<typeof secured>,
  preview: { token: string; confirmationRequirements: string[] },
) {
  return write.post(`/api/mutations/${preview.token}/commit`).send({
    confirmed: true,
    confirmationKeys: preview.confirmationRequirements,
  });
}

describe("卷 mutation API", () => {
  it("删除整卷需要确认终稿范围，提交后移除正文卷及自有卷纲", async () => {
    const { fixture, app, origin, sessionToken } = await setup();
    const write = secured(app, origin, sessionToken);
    const previewUrl = "/api/volumes/v01/delete/preview";
    const preview = await write.post(previewUrl);
    expect(preview.status).toBe(200);
    expect(preview.body.data).toMatchObject({
      kind: "delete",
      confirmationRequirements: [
        "confirm-volume-delete",
        "confirm-final-delete",
      ],
    });
    const rejected = await commit(write, {
      ...preview.body.data,
      confirmationRequirements: ["confirm-volume-delete"],
    });
    expect(rejected.status).toBe(409);
    expect(await fixture.readChapter()).toBe(fixture.originalChapter);

    const confirmed = await write.post(previewUrl);
    const result = await commit(write, confirmed.body.data);
    expect(result.status).toBe(200);
    expect(result.body.data).toMatchObject({
      kind: "delete",
      destinationHref: "/chapters",
    });
    await expect(lstat(fixture.volumeRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      lstat(path.join(fixture.root, "20_规划", "卷", "v01")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await request(app).get("/api/archives/volumes")).body.data).toEqual(
      [],
    );
    expect(
      (await request(app).get("/api/volumes/new")).body.data.volumeId,
    ).toBe("v02");
  });
  it("通过默认值、预览和统一 commit 端点创建卷", async () => {
    const { fixture, app, origin, sessionToken } = await setup();
    const write = secured(app, origin, sessionToken);

    const defaults = await request(app).get("/api/volumes/new");
    expect(defaults.status).toBe(200);
    expect(defaults.body.data).toMatchObject({
      volumeId: "v02",
      volumeNumber: 2,
      targetPath: "40_正文/卷/v02/状态.yaml",
    });

    const preview = await write
      .post("/api/volumes/preview")
      .send({ title: "API 第二卷" });
    expect(preview.status).toBe(200);
    expect(preview.body.data).toMatchObject({
      kind: "create",
      volumeId: "v02",
      confirmationRequirements: ["confirm-volume-create"],
    });

    const committed = await commit(write, preview.body.data);
    expect(committed.status).toBe(200);
    expect(committed.body.data).toMatchObject({
      kind: "create",
      volumeId: "v02",
      destinationHref: "/chapters/volumes/v02",
    });
    const status = yaml.load(
      await readFile(
        path.join(fixture.root, "40_正文", "卷", "v02", "状态.yaml"),
        "utf8",
      ),
    ) as { volume: { title: string } };
    expect(status.volume.title).toBe("API 第二卷");
  });

  it("改名 API 只更新状态 YAML，遗漏确认后 token 不可重放", async () => {
    const { fixture, app, origin, sessionToken } = await setup();
    const write = secured(app, origin, sessionToken);
    const chapterBefore = await fixture.readChapter();

    const preview = await write
      .put("/api/volumes/v01/preview")
      .send({ title: "API 新卷名" });
    expect(preview.status).toBe(200);
    expect(preview.body.data.confirmationRequirements).toEqual([
      "confirm-volume-rename",
    ]);

    const missing = await write
      .post(`/api/mutations/${preview.body.data.token}/commit`)
      .send({ confirmed: true, confirmationKeys: [] });
    expect(missing.status).toBe(409);
    expect(missing.body.error).toMatchObject({
      code: "MUTATION_CONFIRMATION_REQUIRED",
      details: { required: ["confirm-volume-rename"] },
    });

    const replay = await commit(write, preview.body.data);
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe("INVALID_PREVIEW_TOKEN");
    expect(await fixture.readChapter()).toBe(chapterBefore);
  });

  it("空卷归档和恢复均走显式预览，恢复目标冲突返回 409", async () => {
    const { fixture, app, origin, sessionToken } = await setup();
    const write = secured(app, origin, sessionToken);
    const createPreview = await write
      .post("/api/volumes/preview")
      .send({ title: "待归档空卷" });
    expect(createPreview.status).toBe(200);
    expect((await commit(write, createPreview.body.data)).status).toBe(200);

    const archivePreview = await write
      .post("/api/volumes/v02/archive/preview")
      .send({ reason: "API 归档测试" });
    expect(archivePreview.status).toBe(200);
    expect(archivePreview.body.data).toMatchObject({
      kind: "archive",
      archiveId: expect.any(String),
    });
    expect((await commit(write, archivePreview.body.data)).status).toBe(200);

    const restorePreview = await write
      .post(
        `/api/archives/volumes/${archivePreview.body.data.archiveId}/restore/preview`,
      )
      .send();
    expect(restorePreview.status).toBe(200);
    expect(restorePreview.body.data.kind).toBe("restore");

    const conflictStatus = path.join(
      fixture.root,
      "40_正文",
      "卷",
      "v02",
      "状态.yaml",
    );
    await mkdir(path.dirname(conflictStatus), { recursive: true });
    await writeFile(conflictStatus, "冲突占位\n", "utf8");

    const conflict = await commit(write, restorePreview.body.data);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("MUTATION_CONFLICT");
    expect(await readFile(conflictStatus, "utf8")).toBe("冲突占位\n");
  });
});
