import { mkdir, readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMutationEngine,
  type Clock,
  type FaultInjector,
} from "../server/mutations/index.js";
import type { RepositoryFixture } from "./helpers/repository-fixture.js";
import { createRepositoryFixture } from "./helpers/repository-fixture.js";
import {
  expectNoTransientMutationArtifacts,
  readMutationJournals,
} from "./helpers/mutation-assertions.js";

const fixtures: RepositoryFixture[] = [];
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function fixture() {
  const value = await createRepositoryFixture();
  fixtures.push(value);
  return value;
}

describe("mutation 预览与提交", () => {
  it("成功提交 replace 与 create，且不留临时工件", async () => {
    const repository = await fixture();
    const engine = createMutationEngine();
    const finalContent = "# 第二章\n\n已通过 mutation 写入。\n";
    const recordPath = "30_生产/active/mutation-record.md";
    const ticket = await engine.prepareMutation(repository.root, {
      kind: "test-success",
      operations: [
        {
          kind: "replace",
          path: "40_正文/卷/v01/章节/ch002.md",
          content: finalContent,
        },
        { kind: "create", path: recordPath, content: "# 写入记录\n" },
      ],
    });

    expect(await repository.readChapter()).toBe(repository.originalChapter);
    await engine.commitMutation(repository.root, ticket.token);

    expect(await repository.readChapter()).toBe(finalContent);
    expect(await readFile(`${repository.root}/${recordPath}`, "utf8")).toBe(
      "# 写入记录\n",
    );
    expect(await readMutationJournals(repository.root)).toMatchObject([
      { phase: "committed", kind: "test-success" },
    ]);
    await expectNoTransientMutationArtifacts(repository.root);
  });

  it("以原始字节写入二进制文件，并在组合事务失败时完整回滚", async () => {
    const repository = await fixture();
    let installed = 0;
    const engine = createMutationEngine({
      faultInjector: {
        hit(point) {
          if (point === "operation-after-install" && ++installed === 2)
            throw new Error("模拟二进制与文本组合事务失败");
        },
      },
    });
    const coverPath = "70_素材/封面.png";
    const cover = Buffer.from(PNG_BASE64, "base64");
    const ticket = await engine.prepareMutation(repository.root, {
      kind: "test-binary-rollback",
      operations: [
        {
          kind: "create",
          path: coverPath,
          content: PNG_BASE64,
          encoding: "base64",
        },
        {
          kind: "replace",
          path: "40_正文/卷/v01/章节/ch002.md",
          content: "# 不应保留\n",
        },
      ],
    });

    await expect(
      engine.commitMutation(repository.root, ticket.token),
    ).rejects.toThrow("模拟二进制与文本组合事务失败");

    await expect(
      readFile(`${repository.root}/${coverPath}`),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await repository.readChapter()).toBe(repository.originalChapter);

    const success = await engine.prepareMutation(repository.root, {
      kind: "test-binary-create",
      operations: [
        {
          kind: "create",
          path: coverPath,
          content: PNG_BASE64,
          encoding: "base64",
        },
      ],
    });
    await engine.commitMutation(repository.root, success.token);
    expect(await readFile(`${repository.root}/${coverPath}`)).toEqual(cover);
  });

  it("拒绝过期令牌，且首次尝试后不可重放", async () => {
    const repository = await fixture();
    let current = new Date("2026-07-18T00:00:00.000Z");
    const clock: Clock = { now: () => current };
    const engine = createMutationEngine({ clock });
    const ticket = await engine.prepareMutation(repository.root, {
      kind: "test-expiry",
      expiresInMs: 1_000,
      operations: [
        {
          kind: "replace",
          path: "40_正文/卷/v01/章节/ch002.md",
          content: "# 过期后不应写入\n",
        },
      ],
    });
    current = new Date("2026-07-18T00:00:01.001Z");

    await expect(
      engine.commitMutation(repository.root, ticket.token),
    ).rejects.toMatchObject({ code: "PREVIEW_EXPIRED" });
    await expect(
      engine.commitMutation(repository.root, ticket.token),
    ).rejects.toMatchObject({ code: "INVALID_PREVIEW_TOKEN" });
    expect(await repository.readChapter()).toBe(repository.originalChapter);
  });

  it("内容和路径相同也不允许令牌跨仓库使用", async () => {
    const first = await fixture();
    const second = await fixture();
    const engine = createMutationEngine();
    const ticket = await engine.prepareMutation(first.root, {
      kind: "test-repository-binding",
      operations: [
        {
          kind: "replace",
          path: "40_正文/卷/v01/章节/ch002.md",
          content: "# 不应跨仓库写入\n",
        },
      ],
    });

    await expect(
      engine.commitMutation(second.root, ticket.token),
    ).rejects.toMatchObject({ code: "INVALID_PREVIEW_TOKEN" });
    expect(await second.readChapter()).toBe(second.originalChapter);
    await expect(
      engine.commitMutation(first.root, ticket.token),
    ).rejects.toMatchObject({ code: "INVALID_PREVIEW_TOKEN" });
  });

  it("普通失败恢复事务前状态并记录 rolled-back", async () => {
    const repository = await fixture();
    let failed = false;
    const faultInjector: FaultInjector = {
      hit(point) {
        if (point === "operation-after-install" && !failed) {
          failed = true;
          throw new Error("模拟安装后失败");
        }
      },
    };
    const engine = createMutationEngine({ faultInjector });
    const ticket = await engine.prepareMutation(repository.root, {
      kind: "test-rollback",
      operations: [
        {
          kind: "replace",
          path: "40_正文/卷/v01/章节/ch002.md",
          content: "# 失败的新内容\n",
        },
      ],
    });

    await expect(
      engine.commitMutation(repository.root, ticket.token),
    ).rejects.toThrow("模拟安装后失败");

    expect(await repository.readChapter()).toBe(repository.originalChapter);
    expect(await readMutationJournals(repository.root)).toMatchObject([
      { phase: "rolled-back", error: "模拟安装后失败" },
    ]);
    await expectNoTransientMutationArtifacts(repository.root);
  });

  it("提交 remove 后删除目标且不留事务备份", async () => {
    const repository = await fixture();
    const engine = createMutationEngine();
    const ticket = await engine.prepareMutation(repository.root, {
      kind: "test-remove",
      operations: [{ kind: "remove", path: "40_正文/卷/v01/章节/ch002.md" }],
    });

    await engine.commitMutation(repository.root, ticket.token, "test-remove");

    await expect(
      readFile(repository.chapterPath, "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readMutationJournals(repository.root)).toMatchObject([
      { phase: "committed", kind: "test-remove" },
    ]);
    await expectNoTransientMutationArtifacts(repository.root);
  });

  it("create 与 remove 组合失败时同时撤销归档副本并恢复来源", async () => {
    const repository = await fixture();
    const archivePath = "99_归档/工作台回收站/test/ch002.md";
    let failed = false;
    const engine = createMutationEngine({
      faultInjector: {
        hit(point, details) {
          if (
            point === "operation-after-install" &&
            (details as { kind?: string } | undefined)?.kind === "remove" &&
            !failed
          ) {
            failed = true;
            throw new Error("模拟归档来源移除后失败");
          }
        },
      },
    });
    const ticket = await engine.prepareMutation(repository.root, {
      kind: "test-archive-rollback",
      operations: [
        {
          kind: "create",
          path: archivePath,
          content: repository.originalChapter,
        },
        { kind: "remove", path: "40_正文/卷/v01/章节/ch002.md" },
      ],
    });

    await expect(
      engine.commitMutation(repository.root, ticket.token),
    ).rejects.toThrow("模拟归档来源移除后失败");

    expect(await repository.readChapter()).toBe(repository.originalChapter);
    await expect(
      readFile(`${repository.root}/${archivePath}`, "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expectNoTransientMutationArtifacts(repository.root);
  });

  it("文件 guard 在受观察文件变化后拒绝提交", async () => {
    const repository = await fixture();
    const engine = createMutationEngine();
    const ticket = await engine.prepareMutation(repository.root, {
      kind: "test-file-guard",
      guards: [{ kind: "file-hash", path: "40_正文/卷/v01/状态.yaml" }],
      operations: [
        {
          kind: "replace",
          path: "40_正文/卷/v01/章节/ch002.md",
          content: "# 不应写入\n",
        },
      ],
    });
    await writeFile(repository.statusPath, "# 外部修改\n", "utf8");

    await expect(
      engine.commitMutation(repository.root, ticket.token),
    ).rejects.toMatchObject({
      code: "MUTATION_CONFLICT",
      details: { path: "40_正文/卷/v01/状态.yaml", guard: "file-hash" },
    });
    expect(await repository.readChapter()).toBe(repository.originalChapter);
  });

  it("目录快照 guard 在目录树变化后拒绝提交", async () => {
    const repository = await fixture();
    const engine = createMutationEngine();
    const ticket = await engine.prepareMutation(repository.root, {
      kind: "test-directory-guard",
      guards: [{ kind: "directory-snapshot", path: "40_正文/卷/v01/章节" }],
      operations: [
        {
          kind: "replace",
          path: "40_正文/卷/v01/状态.yaml",
          content: await readFile(repository.statusPath, "utf8"),
        },
      ],
    });
    await mkdir(`${repository.root}/40_正文/卷/v01/章节/临时`, {
      recursive: true,
    });
    await writeFile(
      `${repository.root}/40_正文/卷/v01/章节/临时/ch999.md`,
      "# 并发创建\n",
      "utf8",
    );

    await expect(
      engine.commitMutation(repository.root, ticket.token),
    ).rejects.toMatchObject({
      code: "MUTATION_CONFLICT",
      details: {
        path: "40_正文/卷/v01/章节",
        guard: "directory-snapshot",
      },
    });
  });

  it("目录快照 guard 能识别既有文件的内容变化", async () => {
    const repository = await fixture();
    const engine = createMutationEngine();
    const ticket = await engine.prepareMutation(repository.root, {
      kind: "test-directory-content-guard",
      guards: [{ kind: "directory-snapshot", path: "40_正文/卷/v01/章节" }],
      operations: [
        {
          kind: "replace",
          path: "40_正文/卷/v01/状态.yaml",
          content: await readFile(repository.statusPath, "utf8"),
        },
      ],
    });
    await writeFile(repository.chapterPath, "# 外部修改了既有文件\n", "utf8");

    await expect(
      engine.commitMutation(repository.root, ticket.token),
    ).rejects.toMatchObject({
      code: "MUTATION_CONFLICT",
      details: {
        path: "40_正文/卷/v01/章节",
        guard: "directory-snapshot",
      },
    });
  });

  it("create-tree 与 move-tree 以聚合目录身份提交", async () => {
    const repository = await fixture();
    const engine = createMutationEngine();
    const envelope = "99_归档/工作台回收站/tree-test";
    const source = "20_规划/卷/v01";
    const destination = `${envelope}/assets/${source}`;
    const ticket = await engine.prepareMutation(repository.root, {
      kind: "test-tree-operations",
      operations: [
        {
          kind: "create-tree",
          path: envelope,
          entries: [
            { kind: "directory", path: "assets/20_规划/卷" },
            { kind: "file", path: "manifest.yaml", content: "tree: test\n" },
          ],
        },
        { kind: "move-tree", path: source, destinationPath: destination },
      ],
    });

    await engine.commitMutation(repository.root, ticket.token);

    await expect(
      readFile(`${repository.root}/${source}/卷纲.md`, "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await readFile(`${repository.root}/${destination}/卷纲.md`, "utf8"),
    ).toContain("测试卷纲");
    expect(
      await readFile(`${repository.root}/${envelope}/manifest.yaml`, "utf8"),
    ).toBe("tree: test\n");
    await expectNoTransientMutationArtifacts(repository.root);
  });

  it("expected kind 不匹配时消费令牌并拒绝提交", async () => {
    const repository = await fixture();
    const engine = createMutationEngine();
    const ticket = await engine.prepareMutation(repository.root, {
      kind: "chapter-edit:v01:ch002",
      operations: [
        {
          kind: "replace",
          path: "40_正文/卷/v01/章节/ch002.md",
          content: "# 不应被错误入口提交\n",
        },
      ],
    });

    await expect(
      engine.commitMutation(
        repository.root,
        ticket.token,
        "finalize-task:wrong",
      ),
    ).rejects.toMatchObject({ code: "INVALID_PREVIEW_TOKEN" });
    await expect(
      engine.commitMutation(repository.root, ticket.token),
    ).rejects.toMatchObject({ code: "INVALID_PREVIEW_TOKEN" });
    expect(await repository.readChapter()).toBe(repository.originalChapter);
  });
});
