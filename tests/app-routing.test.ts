import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { RepositoryFixture } from "./helpers/repository-fixture.js";
import { createRepositoryFixture } from "./helpers/repository-fixture.js";
import { createApp } from "../server/app.js";

const fixtures: RepositoryFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

describe("浏览器路由回退", () => {
  it.each([
    "/chapters",
    "/chapters/volumes/v01",
    "/chapters/volumes/v01/chapters/ch002",
    "/volumes/v01",
    "/volumes/v01/chapters/ch002",
    "/workflow/test-task",
    "/documents",
    "/documents/view?path=10_%E5%9C%A3%E7%BB%8F%2F%E4%BA%BA%E7%89%A9%2F%E4%B8%BB%E8%A7%92.md",
  ])("直接访问 %s 返回 SPA 入口", async (path) => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);

    const response = await request(createApp(fixture.root).callback())
      .get(path)
      .set("Accept", "text/html");

    expect(response.status).toBe(200);
    expect(response.type).toContain("text/html");
    expect(response.text).toContain('id="root"');
  });
});
