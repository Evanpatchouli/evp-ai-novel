import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMutationEngine,
  SimulatedMutationCrash,
  type FaultInjector,
} from "../server/mutations/index.js";
import type { RepositoryFixture } from "./helpers/repository-fixture.js";
import { createRepositoryFixture } from "./helpers/repository-fixture.js";
import {
  expectNoTransientMutationArtifacts,
  readMutationJournals,
} from "./helpers/mutation-assertions.js";

const fixtures: RepositoryFixture[] = [];
const chapter = "40_正文/卷/v01/章节/ch002.md";

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function createFixture() {
  const value = await createRepositoryFixture();
  fixtures.push(value);
  return value;
}

async function crashAt(
  repository: RepositoryFixture,
  point: string,
  finalContent: string,
) {
  let crashed = false;
  const faultInjector: FaultInjector = {
    hit(current) {
      if (current === point && !crashed) {
        crashed = true;
        throw new SimulatedMutationCrash(`crash at ${point}`);
      }
    },
  };
  const engine = createMutationEngine({ faultInjector });
  const ticket = await engine.prepareMutation(repository.root, {
    kind: `recovery-${point}`,
    operations: [{ kind: "replace", path: chapter, content: finalContent }],
  });
  await expect(
    engine.commitMutation(repository.root, ticket.token),
  ).rejects.toBeInstanceOf(SimulatedMutationCrash);
}

describe("mutation 崩溃恢复", () => {
  it.each(["operation-after-backup", "after-committed-journal"])(
    "删除目录在 %s 中断后按提交状态恢复或清理",
    async (failurePoint) => {
      const repository = await createFixture();
      const committed = failurePoint === "after-committed-journal";
      const engine = createMutationEngine({
        faultInjector: {
          hit(point) {
            if (point === failurePoint) throw new SimulatedMutationCrash(point);
          },
        },
      });
      const ticket = await engine.prepareMutation(repository.root, {
        kind: "delete-volume",
        operations: [{ kind: "remove-tree", path: "40_正文/卷/v01" }],
      });
      await expect(
        engine.commitMutation(repository.root, ticket.token),
      ).rejects.toBeInstanceOf(SimulatedMutationCrash);
      const recovery = await createMutationEngine({
        processLiveness: { isAlive: () => false },
      }).recoverMutationRepository(repository.root);
      expect(recovery.recoveryRequired).toHaveLength(0);
      if (committed)
        await expect(repository.readChapter()).rejects.toMatchObject({
          code: "ENOENT",
        });
      else
        expect(await repository.readChapter()).toBe(repository.originalChapter);
      await expectNoTransientMutationArtifacts(repository.root);
    },
  );
  it.each(["journal-prepared", "operation-after-install"])(
    "%s 中断后由新引擎恢复事务前内容",
    async (point) => {
      const repository = await createFixture();
      await crashAt(repository, point, "# 崩溃前尝试写入\n");

      const recoveryEngine = createMutationEngine({
        processLiveness: { isAlive: () => false },
      });
      const result = await recoveryEngine.recoverMutationRepository(
        repository.root,
      );

      expect(result.recovered).toHaveLength(1);
      expect(result.recoveryRequired).toEqual([]);
      expect(await repository.readChapter()).toBe(repository.originalChapter);
      expect(await readMutationJournals(repository.root)).toMatchObject([
        { phase: "rolled-back" },
      ]);
      await expectNoTransientMutationArtifacts(repository.root);
    },
  );

  it("二进制替换安装后中断可按原始字节恢复旧文件", async () => {
    const repository = await createFixture();
    const cover = "70_素材/封面.png";
    const original = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);
    const replacement = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 255, 0]);
    await mkdir(path.join(repository.root, "70_素材"), { recursive: true });
    await writeFile(path.join(repository.root, cover), original);
    let crashed = false;
    const engine = createMutationEngine({
      faultInjector: {
        hit(point) {
          if (point === "operation-after-install" && !crashed) {
            crashed = true;
            throw new SimulatedMutationCrash("binary crash after install");
          }
        },
      },
    });
    const ticket = await engine.prepareMutation(repository.root, {
      kind: "recovery-binary-cover",
      operations: [
        {
          kind: "replace",
          path: cover,
          content: replacement.toString("base64"),
          encoding: "base64",
        },
      ],
    });
    await expect(
      engine.commitMutation(repository.root, ticket.token),
    ).rejects.toBeInstanceOf(SimulatedMutationCrash);

    const result = await createMutationEngine({
      processLiveness: { isAlive: () => false },
    }).recoverMutationRepository(repository.root);

    expect(result.recovered).toHaveLength(1);
    expect(await readFile(path.join(repository.root, cover))).toEqual(original);
    await expectNoTransientMutationArtifacts(repository.root);
  });

  it("committed 日志落盘后中断只补清理，不回滚成功内容", async () => {
    const repository = await createFixture();
    const finalContent = "# 已持久提交\n\n恢复时必须保留。\n";
    await crashAt(repository, "after-committed-journal", finalContent);

    const recoveryEngine = createMutationEngine({
      processLiveness: { isAlive: () => false },
    });
    const result = await recoveryEngine.recoverMutationRepository(
      repository.root,
    );

    expect(result.cleaned).toHaveLength(1);
    expect(result.recovered).toEqual([]);
    expect(await repository.readChapter()).toBe(finalContent);
    expect(await readMutationJournals(repository.root)).toMatchObject([
      { phase: "committed" },
    ]);
    await expectNoTransientMutationArtifacts(repository.root);
  });

  it("备份被外部篡改时进入 recovery-required 并阻断新写入", async () => {
    const repository = await createFixture();
    await crashAt(repository, "operation-after-install", "# 待恢复内容\n");
    const [crashedJournal] = await readMutationJournals(repository.root);
    const backupPath = crashedJournal!.operations[0]!.backupPath!;
    await writeFile(
      path.join(repository.root, ...backupPath.split("/")),
      "# 外部篡改的备份\n",
      "utf8",
    );

    const recoveryEngine = createMutationEngine({
      processLiveness: { isAlive: () => false },
    });
    const result = await recoveryEngine.recoverMutationRepository(
      repository.root,
    );

    expect(result.recoveryRequired).toEqual([crashedJournal!.transactionId]);
    expect(await readMutationJournals(repository.root)).toMatchObject([
      { phase: "recovery-required" },
    ]);
    await expect(
      recoveryEngine.assertRepositoryWritable(repository.root),
    ).rejects.toMatchObject({ code: "MUTATION_RECOVERY_REQUIRED" });
    expect(await readFile(repository.chapterPath, "utf8")).toBe(
      "# 待恢复内容\n",
    );
  });

  it("remove 在来源移入备份后中断可由新进程恢复", async () => {
    const repository = await createFixture();
    let crashed = false;
    const engine = createMutationEngine({
      faultInjector: {
        hit(point, details) {
          if (
            point === "operation-after-backup" &&
            (details as { kind?: string } | undefined)?.kind === "remove" &&
            !crashed
          ) {
            crashed = true;
            throw new SimulatedMutationCrash("remove crash after backup");
          }
        },
      },
    });
    const ticket = await engine.prepareMutation(repository.root, {
      kind: "recovery-remove",
      operations: [{ kind: "remove", path: chapter }],
    });
    await expect(
      engine.commitMutation(repository.root, ticket.token),
    ).rejects.toBeInstanceOf(SimulatedMutationCrash);

    const recoveryEngine = createMutationEngine({
      processLiveness: { isAlive: () => false },
    });
    const result = await recoveryEngine.recoverMutationRepository(
      repository.root,
    );

    expect(result.recovered).toHaveLength(1);
    expect(await repository.readChapter()).toBe(repository.originalChapter);
    await expectNoTransientMutationArtifacts(repository.root);
  });

  it("move-tree 安装后中断可恢复源目录并清理新建归档树", async () => {
    const repository = await createFixture();
    let crashed = false;
    const engine = createMutationEngine({
      faultInjector: {
        hit(point, details) {
          if (
            point === "operation-after-tree-rename" &&
            (details as { kind?: string } | undefined)?.kind === "move-tree" &&
            !crashed
          ) {
            crashed = true;
            throw new SimulatedMutationCrash("move-tree crash after install");
          }
        },
      },
    });
    const envelope = "99_归档/工作台回收站/recovery-tree";
    const source = "20_规划/卷/v01";
    const destination = `${envelope}/assets/${source}`;
    const ticket = await engine.prepareMutation(repository.root, {
      kind: "recovery-move-tree",
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
    await expect(
      engine.commitMutation(repository.root, ticket.token),
    ).rejects.toBeInstanceOf(SimulatedMutationCrash);

    const recoveryEngine = createMutationEngine({
      processLiveness: { isAlive: () => false },
    });
    const result = await recoveryEngine.recoverMutationRepository(
      repository.root,
    );

    expect(result.recovered).toHaveLength(1);
    expect(
      await readFile(`${repository.root}/${source}/卷纲.md`, "utf8"),
    ).toContain("测试卷纲");
    await expect(
      readFile(`${repository.root}/${envelope}/manifest.yaml`, "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expectNoTransientMutationArtifacts(repository.root);
  });

  it("父目录移动在前序文件替换后中断仍恢复原任务树", async () => {
    const repository = await createFixture();
    const source = "30_生产/active/task-for-archive";
    const destination = "30_生产/archive/task-for-archive";
    const taskPath = `${source}/task.yaml`;
    const originalTask = "id: task-for-archive\nstage: written\n";
    await mkdir(path.join(repository.root, source), { recursive: true });
    await mkdir(path.join(repository.root, "30_生产/archive"), {
      recursive: true,
    });
    await writeFile(path.join(repository.root, taskPath), originalTask, "utf8");
    await writeFile(
      path.join(repository.root, source, "07_写入记录.md"),
      "# 写入记录\n",
      "utf8",
    );
    let crashed = false;
    const engine = createMutationEngine({
      faultInjector: {
        hit(point, details) {
          if (
            point === "operation-after-tree-rename" &&
            (details as { path?: string } | undefined)?.path === source &&
            !crashed
          ) {
            crashed = true;
            throw new SimulatedMutationCrash("archive crash after tree rename");
          }
        },
      },
    });
    const ticket = await engine.prepareMutation(repository.root, {
      kind: "archive-task-for-recovery",
      operations: [
        {
          kind: "replace",
          path: taskPath,
          content: "id: task-for-archive\nstage: archived\n",
        },
        { kind: "move-tree", path: source, destinationPath: destination },
      ],
    });

    await expect(
      engine.commitMutation(repository.root, ticket.token),
    ).rejects.toBeInstanceOf(SimulatedMutationCrash);
    const recovery = await createMutationEngine({
      processLiveness: { isAlive: () => false },
    }).recoverMutationRepository(repository.root);

    expect(recovery.recovered).toHaveLength(1);
    expect(recovery.recoveryRequired).toEqual([]);
    expect(await readFile(path.join(repository.root, taskPath), "utf8")).toBe(
      originalTask,
    );
    expect(
      await readFile(
        path.join(repository.root, source, "07_写入记录.md"),
        "utf8",
      ),
    ).toBe("# 写入记录\n");
    await expect(
      readFile(path.join(repository.root, destination, "task.yaml"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expectNoTransientMutationArtifacts(repository.root);
  });

  it("回退文件移动中断后恢复来源且不留下空 history 目录", async () => {
    const repository = await createFixture();
    const historyRoot = "30_生产/active/rewind-task/history";
    const history = `${historyRoot}/rewind-test`;
    const source = "30_生产/active/rewind-task/03_审稿报告_原文.md";
    const destination = `${history}/03_审稿报告_原文.md`;
    await mkdir(path.join(repository.root, path.posix.dirname(source)), {
      recursive: true,
    });
    await writeFile(path.join(repository.root, source), "审稿原文\n", "utf8");
    let crashed = false;
    const engine = createMutationEngine({
      faultInjector: {
        hit(point, details) {
          if (
            point === "operation-after-install" &&
            (details as { kind?: string } | undefined)?.kind === "move" &&
            !crashed
          ) {
            crashed = true;
            throw new SimulatedMutationCrash("rewind crash after file move");
          }
        },
      },
    });
    const ticket = await engine.prepareMutation(repository.root, {
      kind: "rewind-file-recovery",
      operations: [
        {
          kind: "create-tree",
          path: historyRoot,
          entries: [{ kind: "directory", path: "rewind-test" }],
        },
        { kind: "move", path: source, destinationPath: destination },
      ],
    });

    await expect(
      engine.commitMutation(repository.root, ticket.token),
    ).rejects.toBeInstanceOf(SimulatedMutationCrash);
    const recovery = await createMutationEngine({
      processLiveness: { isAlive: () => false },
    }).recoverMutationRepository(repository.root);

    expect(recovery.recovered).toHaveLength(1);
    expect(await readFile(path.join(repository.root, source), "utf8")).toBe(
      "审稿原文\n",
    );
    await expect(
      readFile(path.join(repository.root, destination), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      (await import("node:fs/promises")).access(
        path.join(repository.root, history),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expectNoTransientMutationArtifacts(repository.root);
  });
});
