import { lstat, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import request from "supertest";
import yaml from "js-yaml";
import { createApp } from "../server/app.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("创建、切换和重启后恢复应用管理的独立小说", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "novel-library-test-"));
  roots.push(root);
  const options = {
    dataRoot: root,
    requestSecurity: {
      mode: "production" as const,
      productionOrigin: "http://127.0.0.1",
    },
  };
  const app = createApp(undefined, options).callback();
  const health = await request(app).get("/api/health");
  let token = health.body.data.sessionToken as string;
  const empty = await request(app).get("/api/novels");
  expect(empty.body.data).toEqual({ novels: [], selectedId: null });
  const create = async (title: string) =>
    request(app)
      .post("/api/novels")
      .set("Origin", "http://127.0.0.1")
      .set("X-Workbench-Session", token)
      .send({ title, author: "作者", description: "简介" });
  const first = await create("第一部");
  expect(first.status).toBe(200);
  const second = await create("第二部");
  expect(second.status).toBe(200);
  const firstId = first.body.data.id as string;
  const firstRoot = path.join(root, "novels", firstId);
  const metadata = yaml.load(
    await readFile(path.join(firstRoot, "00_项目", "小说.yaml"), "utf8"),
  );
  expect(metadata).toMatchObject({
    novel: {
      id: firstId,
      title: "第一部",
      author: "作者",
      description: "简介",
    },
  });
  const chosen = await request(app)
    .post("/api/novels/select")
    .set("Origin", "http://127.0.0.1")
    .set("X-Workbench-Session", token)
    .send({ id: firstId });
  expect(chosen.status).toBe(200);
  token = chosen.body.data.sessionToken;
  const dashboard = await request(app).get("/api/dashboard");
  expect(dashboard.status).toBe(200);
  expect(dashboard.body.data).toMatchObject({
    repositoryRoot: firstRoot,
    projectName: "第一部",
    volumes: [],
  });
  expect((await request(app).get("/api/volumes/new")).status).toBe(200);
  const version = await request(app)
    .post("/api/git/versions")
    .set("Origin", "http://127.0.0.1")
    .set("X-Workbench-Session", token)
    .send({ message: "初始版本" });
  expect(version.status).toBe(200);
  const history = await request(app).get("/api/git/versions");
  expect(history.body.data).toHaveLength(1);
  expect(history.body.data[0].message).toBe("初始版本");
  expect((await request(app).get("/api/git/status")).body.data.clean).toBe(
    true,
  );
  const forbidden = await request(app)
    .post("/api/repository/select")
    .set("Origin", "http://127.0.0.1")
    .set("X-Workbench-Session", token)
    .send({ root });
  expect(forbidden.status).toBe(403);
  const invalid = await request(app)
    .post("/api/novels/select")
    .set("Origin", "http://127.0.0.1")
    .set("X-Workbench-Session", token)
    .send({ id: "../outside" });
  expect(invalid.status).toBe(400);
  const restarted = createApp(undefined, options).callback();
  const list = await request(restarted).get("/api/novels");
  expect(list.body.data.selectedId).toBe(firstId);
  expect(list.body.data.novels).toHaveLength(2);
  expect((await request(restarted).get("/api/dashboard")).status).toBe(200);
});

it("删除需确认，仅删除受管理小说并切换当前小说", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "novel-library-delete-"));
  const outside = await mkdtemp(path.join(tmpdir(), "novel-library-outside-"));
  roots.push(root, outside);
  const options = {
    dataRoot: root,
    requestSecurity: {
      mode: "production" as const,
      productionOrigin: "http://127.0.0.1",
    },
  };
  const app = createApp(undefined, options).callback();
  const health = await request(app).get("/api/health");
  let token: string = health.body.data.sessionToken;
  const write = (method: "post" | "delete", url: string) =>
    request(app)
      [method](url)
      .set("Origin", "http://127.0.0.1")
      .set("X-Workbench-Session", token);
  const create = async (title: string) => {
    const result = await write("post", "/api/novels").send({
      title,
      author: "作者",
    });
    expect(result.status).toBe(200);
    return result.body.data.id as string;
  };
  const first = await create("第一部");
  const second = await create("第二部");
  const third = await create("第三部");
  const libraryRoot = path.join(root, "novels");
  const linked = randomUUID();
  await symlink(
    outside,
    path.join(libraryRoot, linked),
    process.platform === "win32" ? "junction" : "dir",
  );
  const remove = (id: string, confirmed = true) =>
    write("delete", `/api/novels/${id}`).send({ confirmed });
  expect((await remove(linked)).status).toBe(404);
  expect((await lstat(outside)).isDirectory()).toBe(true);
  expect((await remove(first, false)).status).toBe(400);
  expect((await lstat(path.join(libraryRoot, first))).isDirectory()).toBe(true);

  const selection = await write("post", "/api/novels/select").send({
    id: first,
  });
  token = selection.body.data.sessionToken;
  const inactive = await remove(third);
  expect(inactive.body.data).toMatchObject({
    selectedId: first,
    sessionToken: token,
  });
  await expect(lstat(path.join(libraryRoot, third))).rejects.toMatchObject({
    code: "ENOENT",
  });
  const active = await remove(first);
  expect(active.status).toBe(200);
  expect(active.body.data).toMatchObject({
    selectedId: second,
    novels: [{ id: second }],
  });
  expect(active.body.data.sessionToken).not.toBe(token);
  await expect(lstat(path.join(libraryRoot, first))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(
    (await request(app).get("/api/dashboard")).body.data.repositoryRoot,
  ).toBe(path.join(libraryRoot, second));
  const restarted = createApp(undefined, options).callback();
  expect(
    (await request(restarted).get("/api/novels")).body.data.selectedId,
  ).toBe(second);

  token = active.body.data.sessionToken;
  const last = await remove(second);
  expect(last.body.data).toMatchObject({ selectedId: null, novels: [] });
  expect((await request(app).get("/api/dashboard")).status).toBe(404);
});
