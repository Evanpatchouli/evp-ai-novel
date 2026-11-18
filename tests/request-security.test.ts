import { afterEach, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import request from "supertest";
import { createApp } from "../server/app.js";
import { commitMutation, prepareMutation } from "../server/mutations/index.js";
import {
  createSessionTokenManager,
  isAllowedWorkbenchOrigin,
  isLoopbackHost,
} from "../server/request-security.js";
import type { RepositoryFixture } from "./helpers/repository-fixture.js";
import { createRepositoryFixture } from "./helpers/repository-fixture.js";

const fixtures: RepositoryFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

describe("本地请求边界", () => {
  it("只接受回环 Host 和受信任开发 Origin", () => {
    expect(isLoopbackHost("localhost:6174")).toBe(true);
    expect(isLoopbackHost("127.0.0.1:6174")).toBe(true);
    expect(isLoopbackHost("[::1]:6174")).toBe(true);
    expect(isLoopbackHost("evil.example:6174")).toBe(false);
    expect(
      isAllowedWorkbenchOrigin(
        "http://localhost:6173",
        "http://127.0.0.1:6174",
        { mode: "development" },
      ),
    ).toBe(true);
    expect(
      isAllowedWorkbenchOrigin(
        "https://evil.example",
        "http://127.0.0.1:6174",
        { mode: "development" },
      ),
    ).toBe(false);
  });

  it("写请求必须携带同源 Origin 和当前 session token", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const tokens = createSessionTokenManager("initial-session-token");
    const app = createApp(fixture.root, {
      requestSecurity: {
        sessionTokens: tokens,
        mode: "production",
        productionOrigin: "http://127.0.0.1",
      },
    }).callback();

    const missingToken = await request(app)
      .post("/api/repository/select")
      .set("Origin", "http://127.0.0.1")
      .send({ root: fixture.root });
    expect(missingToken.status).toBe(403);
    expect(missingToken.body.error.code).toBe("INVALID_SESSION_TOKEN");

    const selected = await request(app)
      .post("/api/repository/select")
      .set("Origin", "http://127.0.0.1")
      .set("X-Workbench-Session", "initial-session-token")
      .send({ root: fixture.root });
    expect(selected.status).toBe(200);
    expect(selected.body.data.sessionToken).toBe(tokens.current());
    expect(tokens.current()).not.toBe("initial-session-token");

    const replay = await request(app)
      .post("/api/repository/select")
      .set("Origin", "http://127.0.0.1")
      .set("X-Workbench-Session", "initial-session-token")
      .send({ root: fixture.root });
    expect(replay.status).toBe(403);
    expect(replay.body.error.code).toBe("INVALID_SESSION_TOKEN");
  });

  it("拒绝 DNS rebinding 风格的非回环 Host", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);

    const response = await request(createApp(fixture.root).callback())
      .get("/api/health")
      .set("Host", "evil.example:6174");

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("HOST_NOT_ALLOWED");
  });

  it("仓库切换成功后同时轮换请求会话并使旧写入预览失效", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const tokens = createSessionTokenManager("initial-session-token");
    const app = createApp(fixture.root, {
      requestSecurity: {
        sessionTokens: tokens,
        mode: "production",
        productionOrigin: "http://127.0.0.1",
      },
    }).callback();
    const preview = await prepareMutation(fixture.root, {
      kind: "session-switch-test",
      operations: [
        {
          kind: "replace",
          path: "40_正文/卷/v01/章节/ch002.md",
          content: "不会写入\n",
        },
      ],
    });

    const selected = await request(app)
      .post("/api/repository/select")
      .set("Origin", "http://127.0.0.1")
      .set("X-Workbench-Session", "initial-session-token")
      .send({ root: fixture.root });

    expect(selected.status).toBe(200);
    expect(selected.body.data.sessionToken).not.toBe("initial-session-token");
    await expect(
      commitMutation(fixture.root, preview.token),
    ).rejects.toMatchObject({ code: "INVALID_PREVIEW_TOKEN" });
  });

  it("候选仓库需要人工恢复时保持当前仓库与 session token 不变", async () => {
    const current = await createRepositoryFixture();
    const candidate = await createRepositoryFixture();
    fixtures.push(current, candidate);
    await mkdir(path.join(candidate.root, ".workbench"), { recursive: true });
    await writeFile(
      path.join(candidate.root, ".workbench", "recovery-required.yaml"),
      "schemaVersion: 1\nreason: test\n",
      "utf8",
    );
    const tokens = createSessionTokenManager("initial-session-token");
    const app = createApp(current.root, {
      requestSecurity: {
        sessionTokens: tokens,
        mode: "production",
        productionOrigin: "http://127.0.0.1",
      },
    }).callback();

    const failed = await request(app)
      .post("/api/repository/select")
      .set("Origin", "http://127.0.0.1")
      .set("X-Workbench-Session", "initial-session-token")
      .send({ root: candidate.root });
    const repository = await request(app).get("/api/repository");

    expect(failed.status).toBe(503);
    expect(failed.body.error.code).toBe("MUTATION_RECOVERY_REQUIRED");
    expect(repository.body.data.root).toBe(current.root);
    expect(tokens.current()).toBe("initial-session-token");
  });

  it.each([
    ["创建任务", "post", "/api/tasks", { volumeId: "v01", chapterId: "ch002" }],
    [
      "构建上下文",
      "post",
      "/api/tasks/missing/context/build",
      { selectedPaths: ["x"] },
    ],
    ["导入审稿", "post", "/api/tasks/missing/review", { content: "审稿" }],
    ["记录决策", "put", "/api/tasks/missing/decisions", { decisions: [] }],
    ["导入修订", "post", "/api/tasks/missing/revision", { content: "修订" }],
    [
      "保存人工终审",
      "put",
      "/api/tasks/missing/human-final",
      { content: "终审" },
    ],
    [
      "确认终稿",
      "post",
      "/api/tasks/missing/final-confirmation",
      {
        fullyRead: true,
        plotAndCharacterApproved: true,
        noUnauthorizedCanon: true,
        continuityApproved: true,
        willingToFinalize: true,
      },
    ],
    ["生成写入预览", "post", "/api/tasks/missing/write/preview", {}],
    [
      "提交正式写入",
      "post",
      "/api/tasks/missing/write/commit",
      { token: crypto.randomUUID() },
    ],
    ["任务阶段回退", "put", "/api/tasks/missing/stage", { stage: "created" }],
    ["归档任务", "post", "/api/tasks/missing/archive", {}],
  ] as const)(
    "%s 在进入路由前统一拒绝非法 Host、Origin 和 session",
    async (_name, method, endpoint, body) => {
      const fixture = await createRepositoryFixture();
      fixtures.push(fixture);
      const tokens = createSessionTokenManager("matrix-session-token");
      const origin = "http://127.0.0.1";
      const app = createApp(fixture.root, {
        requestSecurity: {
          sessionTokens: tokens,
          mode: "production",
          productionOrigin: origin,
        },
      }).callback();
      const send = (headers: Record<string, string>) => {
        const test =
          method === "post"
            ? request(app).post(endpoint)
            : request(app).put(endpoint);
        for (const [key, value] of Object.entries(headers))
          test.set(key, value);
        return test.send(body);
      };

      const [invalidHost, invalidOrigin, missingSession, invalidSession] =
        await Promise.all([
          send({
            Host: "evil.example:6174",
            Origin: origin,
            "X-Workbench-Session": tokens.current(),
          }),
          send({
            Origin: "https://evil.example",
            "X-Workbench-Session": tokens.current(),
          }),
          send({ Origin: origin }),
          send({
            Origin: origin,
            "X-Workbench-Session": "expired-session-token",
          }),
        ]);

      expect(invalidHost.status).toBe(403);
      expect(invalidHost.body.error.code).toBe("HOST_NOT_ALLOWED");
      expect(invalidOrigin.status).toBe(403);
      expect(invalidOrigin.body.error.code).toBe("ORIGIN_NOT_ALLOWED");
      expect(missingSession.status).toBe(403);
      expect(missingSession.body.error.code).toBe("INVALID_SESSION_TOKEN");
      expect(invalidSession.status).toBe(403);
      expect(invalidSession.body.error.code).toBe("INVALID_SESSION_TOKEN");
    },
  );
});
