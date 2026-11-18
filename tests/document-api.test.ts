import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
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

describe("文档 API 预览、确认与回收站", () => {
  it("读取文档树，并通过统一 commit 创建文档", async () => {
    const { fixture, app, origin, sessionToken } = await setup();
    const write = secured(app, origin, sessionToken);
    const tree = await request(app).get("/api/documents/tree");
    expect(tree.status).toBe(200);
    expect(tree.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "directory", path: "10_圣经" }),
      ]),
    );

    const preview = await write.post("/api/documents/preview").send({
      path: "10_圣经/人物/星港.md",
      content: "# 星港\n\nAPI 创建。\n",
    });
    expect(preview.status).toBe(200);
    expect(preview.body.data).toMatchObject({
      kind: "create",
      targetPath: "10_圣经/人物/星港.md",
    });
    expect((await commit(write, preview.body.data)).status).toBe(200);
    expect(
      await readFile(
        path.join(fixture.root, "10_圣经", "人物", "星港.md"),
        "utf8",
      ),
    ).toContain("API 创建");
  });

  it("归档和恢复均只返回预览，确认缺失后 token 不可重放", async () => {
    const { fixture, app, origin, sessionToken } = await setup();
    await mkdir(path.join(fixture.root, "70_素材"), { recursive: true });
    const write = secured(app, origin, sessionToken);
    const created = await write.post("/api/documents/preview").send({
      path: "70_素材/待归档.md",
      content: "# 待归档\n",
    });
    await commit(write, created.body.data);
    const detail = await request(app).get("/api/documents/content").query({
      path: "70_素材/待归档.md",
    });

    const archive = await write.post("/api/documents/archive/preview").send({
      path: "70_素材/待归档.md",
      reason: "API 归档",
      expectedHash: detail.body.data.sourceHash,
    });
    expect(archive.status).toBe(200);
    expect(archive.body.data.archiveId).toEqual(expect.any(String));

    const missing = await write
      .post(`/api/mutations/${archive.body.data.token}/commit`)
      .send({ confirmed: true, confirmationKeys: [] });
    expect(missing.status).toBe(409);
    expect(missing.body.error.code).toBe("MUTATION_CONFIRMATION_REQUIRED");
    const replay = await commit(write, archive.body.data);
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe("INVALID_PREVIEW_TOKEN");

    const archiveAgain = await write
      .post("/api/documents/archive/preview")
      .send({
        path: "70_素材/待归档.md",
        reason: "API 归档",
        expectedHash: detail.body.data.sourceHash,
      });
    await commit(write, archiveAgain.body.data);
    await expect(
      access(path.join(fixture.root, "70_素材", "待归档.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const archives = await request(app).get("/api/archives/documents");
    expect(archives.body.data).toContainEqual(
      expect.objectContaining({ id: archiveAgain.body.data.archiveId }),
    );
    const restore = await write
      .post(
        `/api/archives/documents/${archiveAgain.body.data.archiveId}/restore/preview`,
      )
      .send();
    expect(restore.status).toBe(200);
    expect((await commit(write, restore.body.data)).status).toBe(200);
    expect(
      await readFile(path.join(fixture.root, "70_素材", "待归档.md"), "utf8"),
    ).toBe("# 待归档\n");
  });

  it("新增写接口拒绝非同源 Origin 和无效 session", async () => {
    const { app, origin, sessionToken } = await setup();
    const body = {
      path: "10_圣经/人物/安全.md",
      content: "# 安全\n",
    };
    const [evilOrigin, missingSession, valid] = await Promise.all([
      request(app)
        .post("/api/documents/preview")
        .set("Origin", "https://evil.example")
        .set("X-Workbench-Session", sessionToken)
        .send(body),
      request(app)
        .post("/api/documents/preview")
        .set("Origin", origin)
        .send(body),
      request(app)
        .post("/api/documents/preview")
        .set("Origin", origin)
        .set("X-Workbench-Session", sessionToken)
        .send(body),
    ]);

    expect(evilOrigin.status).toBe(403);
    expect(evilOrigin.body.error.code).toBe("ORIGIN_NOT_ALLOWED");
    expect(missingSession.status).toBe(403);
    expect(missingSession.body.error.code).toBe("INVALID_SESSION_TOKEN");
    expect(valid.status).toBe(200);
  });
});

describe("小说元数据 API", () => {
  it("缺失时只读返回兼容默认值，结构化修改走统一确认", async () => {
    const { fixture, app, origin, sessionToken } = await setup();
    await mkdir(path.join(fixture.root, "00_项目"), { recursive: true });
    const write = secured(app, origin, sessionToken);
    const before = await request(app).get("/api/novel");
    expect(before.status).toBe(200);
    expect(before.body.data).toMatchObject({ exists: false });

    const preview = await write.put("/api/novel/preview").send({
      title: "示例小说",
      author: "测试作者",
      description: "API 结构化元数据",
      currentVolume: "v01",
      currentChapter: "ch002",
      coverUpload: {
        name: "封面.png",
        mimeType: "image/png",
        contentBase64:
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      },
    });
    expect(preview.status).toBe(200);
    expect(preview.body.data.targetPath).toBe("00_项目/小说.yaml");
    expect((await commit(write, preview.body.data)).status).toBe(200);
    expect(
      await readFile(path.join(fixture.root, "00_项目", "小说.yaml"), "utf8"),
    ).toContain("cover: 70_素材/封面.png");
    expect(
      await readFile(path.join(fixture.root, "70_素材", "封面.png")),
    ).toEqual(expect.any(Buffer));
  });
});
