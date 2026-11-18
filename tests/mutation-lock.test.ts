import { afterEach, describe, expect, it } from "vitest";
import {
  createMutationEngine,
  SimulatedMutationCrash,
  type FaultInjector,
} from "../server/mutations/index.js";
import type { RepositoryFixture } from "./helpers/repository-fixture.js";
import { createRepositoryFixture } from "./helpers/repository-fixture.js";
import { expectNoTransientMutationArtifacts } from "./helpers/mutation-assertions.js";

const fixtures: RepositoryFixture[] = [];
const chapter = "40_正文/卷/v01/章节/ch002.md";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function createFixture() {
  const value = await createRepositoryFixture();
  fixtures.push(value);
  return value;
}

describe("mutation 仓库锁", () => {
  it("同仓库并发提交只允许一个进入事务", async () => {
    const repository = await createFixture();
    const lockAcquired = deferred<void>();
    const release = deferred<void>();
    let shouldWait = true;
    const firstFaults: FaultInjector = {
      async hit(point) {
        if (point === "lock-acquired" && shouldWait) {
          shouldWait = false;
          lockAcquired.resolve();
          await release.promise;
        }
      },
    };
    const firstEngine = createMutationEngine({ faultInjector: firstFaults });
    const secondEngine = createMutationEngine();
    const firstTicket = await firstEngine.prepareMutation(repository.root, {
      kind: "first-concurrent-write",
      operations: [
        { kind: "replace", path: chapter, content: "# 第一个提交\n" },
      ],
    });
    const secondTicket = await secondEngine.prepareMutation(repository.root, {
      kind: "second-concurrent-write",
      operations: [
        { kind: "replace", path: chapter, content: "# 第二个提交\n" },
      ],
    });

    const firstCommit = firstEngine.commitMutation(
      repository.root,
      firstTicket.token,
    );
    await lockAcquired.promise;
    await expect(
      secondEngine.commitMutation(repository.root, secondTicket.token),
    ).rejects.toMatchObject({ code: "REPOSITORY_LOCKED" });
    release.resolve();
    await firstCommit;

    expect(await repository.readChapter()).toBe("# 第一个提交\n");
    await expectNoTransientMutationArtifacts(repository.root);
  });

  it("非事务写入守卫也会阻止 mutation 并发提交", async () => {
    const repository = await createFixture();
    const guardEntered = deferred<void>();
    const releaseGuard = deferred<void>();
    const guardEngine = createMutationEngine();
    const mutationEngine = createMutationEngine();
    const ticket = await mutationEngine.prepareMutation(repository.root, {
      kind: "guard-conflict",
      operations: [{ kind: "replace", path: chapter, content: "# 不应写入\n" }],
    });
    const guarded = guardEngine.withRepositoryWriteGuard(
      repository.root,
      "legacy-write",
      async () => {
        guardEntered.resolve();
        await releaseGuard.promise;
      },
    );

    await guardEntered.promise;
    await expect(
      mutationEngine.commitMutation(repository.root, ticket.token),
    ).rejects.toMatchObject({ code: "REPOSITORY_LOCKED" });
    releaseGuard.resolve();
    await guarded;
    expect(await repository.readChapter()).toBe(repository.originalChapter);
    await expectNoTransientMutationArtifacts(repository.root);
  });

  it("启动恢复不会接管仍属于活动进程的锁", async () => {
    const repository = await createFixture();
    const crashingEngine = createMutationEngine({
      faultInjector: {
        hit(point) {
          if (point === "journal-prepared")
            throw new SimulatedMutationCrash("leave live lock");
        },
      },
    });
    const ticket = await crashingEngine.prepareMutation(repository.root, {
      kind: "live-lock",
      operations: [{ kind: "replace", path: chapter, content: "# 未提交\n" }],
    });
    await expect(
      crashingEngine.commitMutation(repository.root, ticket.token),
    ).rejects.toBeInstanceOf(SimulatedMutationCrash);

    const recoveryEngine = createMutationEngine({
      processLiveness: { isAlive: () => true },
    });
    await expect(
      recoveryEngine.recoverMutationRepository(repository.root),
    ).rejects.toMatchObject({ code: "REPOSITORY_LOCKED" });
  });
});
