import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../server/app.js";
import { buildContextPackage, createTask } from "../server/tasks.js";
import type { RepositoryFixture } from "./helpers/repository-fixture.js";
import { createRepositoryFixture } from "./helpers/repository-fixture.js";

const fixtures: RepositoryFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

describe("上下文选择刷新恢复", () => {
  it("任务详情返回实际打包资料及其勾选状态", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const task = await createTask(fixture.root, "v01", "ch002");
    const selectedPath = "40_正文/卷/v01/章节/ch002.md";
    await buildContextPackage(fixture.root, task.id, [selectedPath]);

    const response = await request(createApp(fixture.root).callback()).get(
      `/api/tasks/${task.id}`,
    );

    expect(response.status).toBe(200);
    expect(response.body.data.context).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: selectedPath, selected: true }),
        expect.objectContaining({
          path: "10_圣经/人物/主角.md",
          selected: false,
        }),
      ]),
    );
  });
});
