import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import yaml from "js-yaml";
import { AppError, assert } from "../errors.js";
import { resolveInside, sha256 } from "../files.js";
import {
  mutationPlanSchema,
  transactionJournalSchema,
  type MutationOperation,
  type MutationPlan,
  type MutationTicket,
  type RecoveryResult,
  type TransactionJournal,
} from "./domain.js";
import { nodeFileOps, type FileOps } from "./file-ops.js";

export interface Clock {
  now(): Date;
}

export interface FaultInjector {
  hit(point: string, details?: unknown): void | Promise<void>;
}

/** 测试专用：模拟进程在检查点直接终止，不执行当前实例的补偿或清理。 */
export class SimulatedMutationCrash extends Error {}

export interface ProcessLiveness {
  isAlive(pid: number): boolean | Promise<boolean>;
}

export interface MutationEngineDependencies {
  fileOps?: FileOps;
  clock?: Clock;
  faultInjector?: FaultInjector;
  processLiveness?: ProcessLiveness;
}

interface PreviewRecord {
  ticket: MutationTicket;
  root: string;
  operations: MutationOperation[];
}

interface LockRecord {
  schemaVersion: 1;
  ownerToken: string;
  kind: "transaction" | "guard";
  transactionId?: string;
  operation: string;
  repositoryFingerprint: string;
  pid: number;
  acquiredAt: string;
}

const noopFaultInjector: FaultInjector = { hit: () => undefined };
const systemClock: Clock = { now: () => new Date() };
const systemProcessLiveness: ProcessLiveness = {
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
};

function normalizedRealPath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createMutationEngine(
  dependencies: MutationEngineDependencies = {},
) {
  const files = dependencies.fileOps ?? nodeFileOps;
  const clock = dependencies.clock ?? systemClock;
  const faults = dependencies.faultInjector ?? noopFaultInjector;
  const liveness = dependencies.processLiveness ?? systemProcessLiveness;
  const previews = new Map<string, PreviewRecord>();
  const epochs = new Map<string, string>();

  const workspace = (root: string) => path.join(root, ".workbench");
  const transactions = (root: string) =>
    path.join(workspace(root), "transactions");
  const lockPath = (root: string) => path.join(workspace(root), "write.lock");
  const recoveryMarkerPath = (root: string) =>
    path.join(workspace(root), "recovery-required.yaml");
  const journalPath = (root: string, id: string) =>
    path.join(transactions(root), `${id}.yaml`);

  async function canonicalRoot(root: string): Promise<string> {
    return normalizedRealPath(await files.realpath(path.resolve(root)));
  }

  async function fingerprint(root: string): Promise<string> {
    return createHash("sha256")
      .update("novel\0", "utf8")
      .update(await canonicalRoot(root), "utf8")
      .digest("hex");
  }

  async function epoch(root: string): Promise<string> {
    const key = await canonicalRoot(root);
    let value = epochs.get(key);
    if (!value) {
      value = randomUUID();
      epochs.set(key, value);
    }
    return value;
  }

  function absolute(root: string, relative: string): string {
    return resolveInside(root, relative);
  }

  async function readHash(file: string): Promise<string | undefined> {
    return (await files.exists(file))
      ? sha256(await files.readBytes(file))
      : undefined;
  }

  function operationContent(
    operation: Extract<MutationOperation, { kind: "create" | "replace" }>,
  ): string | Buffer {
    if (operation.encoding !== "base64") return operation.content;
    assert(
      operation.content.length > 0 &&
        operation.content.length % 4 === 0 &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(operation.content),
      "INVALID_BINARY_CONTENT",
      "二进制 mutation 内容不是规范 Base64",
    );
    const content = Buffer.from(operation.content, "base64");
    assert(
      content.toString("base64") === operation.content,
      "INVALID_BINARY_CONTENT",
      "二进制 mutation 内容不是规范 Base64",
    );
    return content;
  }

  async function readTreeHash(directory: string): Promise<string | undefined> {
    try {
      return await files.snapshotDirectory(directory);
    } catch (error) {
      if (
        ["ENOENT", "ENOTDIR"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        return undefined;
      throw error;
    }
  }

  async function readGuardHash(
    root: string,
    guard: { kind: "file-hash" | "directory-snapshot"; path: string },
  ): Promise<string | undefined> {
    if (guard.kind === "file-hash") return readHash(absolute(root, guard.path));
    return readTreeHash(absolute(root, guard.path));
  }

  async function readRemovalTreeHash(
    directory: string,
  ): Promise<string | undefined> {
    const target = await files
      .realpath(directory)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR")
          return undefined;
        throw error;
      });
    if (!target) return undefined;
    assert(
      path.relative(directory, target) === "",
      "UNSAFE_REMOVAL_TREE",
      "删除目录经过符号链接或 junction",
      409,
    );
    return readTreeHash(directory);
  }

  async function saveJournal(root: string, journal: TransactionJournal) {
    journal.updatedAt = clock.now().toISOString();
    await files.atomicWrite(
      journalPath(root, journal.transactionId),
      yaml.dump(journal, { noRefs: true, lineWidth: 120 }),
    );
  }

  async function loadJournals(root: string): Promise<TransactionJournal[]> {
    if (!(await files.exists(transactions(root)))) return [];
    const names = (await files.readDirectory(transactions(root))).filter(
      (name) => name.endsWith(".yaml"),
    );
    const journals: TransactionJournal[] = [];
    for (const name of names) {
      try {
        journals.push(
          transactionJournalSchema.parse(
            yaml.load(
              await files.readText(path.join(transactions(root), name)),
            ),
          ),
        );
      } catch (error) {
        throw new AppError(
          "MUTATION_RECOVERY_REQUIRED",
          "事务日志无法安全解析，需要人工恢复",
          503,
          { journal: name, error: errorMessage(error) },
        );
      }
    }
    return journals;
  }

  async function acquireLock(root: string, record: LockRecord) {
    await files.mkdir(workspace(root));
    try {
      await files.writeExclusive(lockPath(root), yaml.dump(record));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new AppError(
          "REPOSITORY_LOCKED",
          "小说仓库正在执行另一项写入",
          409,
        );
      }
      throw error;
    }
  }

  async function readLock(root: string): Promise<LockRecord> {
    try {
      const value = yaml.load(
        await files.readText(lockPath(root)),
      ) as Partial<LockRecord>;
      assert(
        value.schemaVersion === 1 &&
          typeof value.ownerToken === "string" &&
          ["transaction", "guard"].includes(value.kind ?? "") &&
          typeof value.operation === "string" &&
          typeof value.repositoryFingerprint === "string" &&
          typeof value.pid === "number" &&
          typeof value.acquiredAt === "string",
        "MUTATION_RECOVERY_REQUIRED",
        "写入锁内容异常，需要人工恢复",
        503,
      );
      return value as LockRecord;
    } catch (error) {
      throw error instanceof AppError
        ? error
        : new AppError(
            "MUTATION_RECOVERY_REQUIRED",
            "写入锁无法解析，需要人工恢复",
            503,
          );
    }
  }

  async function releaseLock(root: string, ownerToken: string) {
    if (!(await files.exists(lockPath(root)))) return;
    const current = await readLock(root);
    if (current.ownerToken === ownerToken) await files.remove(lockPath(root));
  }

  async function markRepositoryRecoveryRequired(
    root: string,
    details: Record<string, unknown>,
  ) {
    await files.atomicWrite(
      recoveryMarkerPath(root),
      yaml.dump({
        schemaVersion: 1,
        ...details,
        recordedAt: clock.now().toISOString(),
      }),
    );
  }

  function relocatedPath(journal: TransactionJournal, relative: string) {
    let relocated = relative;
    for (const operation of journal.operations) {
      if (
        operation.kind === "move-tree" &&
        (relocated === operation.path ||
          relocated.startsWith(`${operation.path}/`))
      ) {
        relocated = `${operation.destinationPath}${relocated.slice(operation.path.length)}`;
      }
    }
    return relocated;
  }

  async function cleanArtifacts(root: string, journal: TransactionJournal) {
    const artifactPath = (relative: string) =>
      journal.phase === "committed"
        ? relocatedPath(journal, relative)
        : relative;
    for (const operation of journal.operations) {
      if ("temporaryPath" in operation)
        await files.remove(
          absolute(root, artifactPath(operation.temporaryPath)),
        );
      if ("backupPath" in operation)
        await files.remove(absolute(root, artifactPath(operation.backupPath)));
    }
  }

  async function rollBack(root: string, journal: TransactionJournal) {
    for (const operation of [...journal.operations].reverse()) {
      const target = absolute(root, operation.path);
      if (operation.kind === "move") {
        const destination = absolute(root, operation.destinationPath);
        const sourceHash = await readHash(target);
        const destinationHash = await readHash(destination);
        if (
          sourceHash === undefined &&
          destinationHash === operation.beforeHash
        ) {
          await files.rename(destination, target);
        } else if (
          sourceHash !== operation.beforeHash ||
          destinationHash !== undefined
        ) {
          throw new Error(`无法判断文件移动恢复状态：${operation.path}`);
        }
        continue;
      }
      if (operation.kind === "move-tree") {
        const destination = absolute(root, operation.destinationPath);
        const sourceHash = await readTreeHash(target);
        const destinationHash = await readTreeHash(destination);
        const installedHash = operation.movedHash ?? operation.beforeHash;
        if (sourceHash === undefined && destinationHash === installedHash) {
          await files.rename(destination, target);
        } else if (
          destinationHash !== undefined ||
          (sourceHash !== operation.beforeHash && sourceHash !== installedHash)
        ) {
          throw new Error(`无法判断目录树恢复状态：${operation.path}`);
        }
        continue;
      }
      if (operation.kind === "create-tree") {
        const currentTreeHash = await readTreeHash(target);
        if (currentTreeHash === operation.afterHash) await files.remove(target);
        else if (currentTreeHash !== undefined)
          throw new Error(`创建目录树已被外部修改：${operation.path}`);
        continue;
      }
      const backup =
        "backupPath" in operation
          ? absolute(root, operation.backupPath)
          : undefined;
      const hash =
        operation.kind === "remove-tree" ? readRemovalTreeHash : readHash;
      const currentHash = await hash(target);

      if (operation.kind === "create") {
        if (currentHash === operation.afterHash) await files.remove(target);
        else if (currentHash !== undefined)
          throw new Error(`创建目标已被外部修改：${operation.path}`);
        continue;
      }

      const backupHash = await hash(backup!);
      if (backupHash !== undefined && backupHash !== operation.beforeHash) {
        throw new Error(`备份哈希异常：${operation.path}`);
      }
      if (operation.kind === "remove" || operation.kind === "remove-tree") {
        if (currentHash === undefined && backupHash === operation.beforeHash) {
          await files.rename(backup!, target);
        } else if (
          currentHash !== operation.beforeHash ||
          backupHash !== undefined
        ) {
          throw new Error(`无法判断文件恢复状态：${operation.path}`);
        }
        continue;
      }

      if (currentHash === operation.afterHash) {
        await files.remove(target);
        await files.rename(backup!, target);
      } else if (
        currentHash === undefined &&
        backupHash === operation.beforeHash &&
        backup
      ) {
        await files.rename(backup, target);
      } else if (currentHash !== operation.beforeHash) {
        throw new Error(`无法判断文件恢复状态：${operation.path}`);
      } else if (backupHash !== undefined) {
        await files.remove(backup!);
      }
    }
  }

  async function markRecoveryRequired(
    root: string,
    journal: TransactionJournal,
    error: unknown,
  ) {
    journal.phase = "recovery-required";
    journal.error = errorMessage(error);
    await saveJournal(root, journal).catch(() => undefined);
  }

  async function prepareMutation(
    rootInput: string,
    input: MutationPlan,
  ): Promise<MutationTicket> {
    const root = await canonicalRoot(rootInput);
    const plan = mutationPlanSchema.parse(input);
    const paths = plan.operations.flatMap((operation) =>
      operation.kind === "move-tree" || operation.kind === "move"
        ? [operation.path, operation.destinationPath]
        : [operation.path],
    );
    assert(
      new Set(paths).size === paths.length,
      "DUPLICATE_MUTATION_PATH",
      "事务中存在重复目标路径",
    );
    await assertRepositoryWritable(root);
    const repositoryFingerprint = await fingerprint(root);
    const sessionEpoch = await epoch(root);
    const preconditions = [] as MutationTicket["preconditions"];
    for (const operation of plan.operations) {
      if (operation.kind === "create-tree") {
        assert(
          !(await files.exists(absolute(root, operation.path))),
          "MUTATION_TARGET_EXISTS",
          "待创建目录树已存在",
          409,
        );
        preconditions.push({
          kind: operation.kind,
          path: operation.path,
          expected: "absent",
        });
        continue;
      }
      if (operation.kind === "move-tree") {
        const beforeHash = await readTreeHash(absolute(root, operation.path));
        assert(
          beforeHash !== undefined,
          "MUTATION_TARGET_MISSING",
          "待移动目录树不存在",
          409,
        );
        assert(
          !(await files.exists(absolute(root, operation.destinationPath))),
          "MUTATION_TARGET_EXISTS",
          "目录树移动目标已存在",
          409,
        );
        preconditions.push({
          kind: operation.kind,
          path: operation.path,
          destinationPath: operation.destinationPath,
          expected: "exists",
          beforeHash,
          afterHash: beforeHash,
        });
        continue;
      }
      if (operation.kind === "move") {
        const beforeHash = await readHash(absolute(root, operation.path));
        assert(
          beforeHash !== undefined,
          "MUTATION_TARGET_MISSING",
          "待移动文件不存在",
          409,
        );
        assert(
          !(await files.exists(absolute(root, operation.destinationPath))),
          "MUTATION_TARGET_EXISTS",
          "文件移动目标已存在",
          409,
        );
        preconditions.push({
          kind: operation.kind,
          path: operation.path,
          destinationPath: operation.destinationPath,
          expected: "exists",
          beforeHash,
          afterHash: beforeHash,
        });
        continue;
      }
      const hash =
        operation.kind === "remove-tree" ? readRemovalTreeHash : readHash;
      const beforeHash = await hash(absolute(root, operation.path));
      const expectsExisting = operation.kind !== "create";
      assert(
        expectsExisting ? beforeHash !== undefined : beforeHash === undefined,
        expectsExisting ? "MUTATION_TARGET_MISSING" : "MUTATION_TARGET_EXISTS",
        expectsExisting ? "待修改文件不存在" : "待创建文件已存在",
        409,
      );
      preconditions.push({
        kind: operation.kind,
        path: operation.path,
        expected: expectsExisting ? "exists" : "absent",
        beforeHash,
        afterHash:
          operation.kind === "remove" || operation.kind === "remove-tree"
            ? undefined
            : sha256(operationContent(operation)),
      });
    }
    const guards: MutationTicket["guards"] = [];
    for (const guard of plan.guards) {
      const beforeHash = await readGuardHash(root, guard);
      if (beforeHash === undefined) {
        throw new AppError(
          "MUTATION_GUARD_MISSING",
          "待观察的文件或目录不存在",
          409,
          { path: guard.path, guard: guard.kind },
        );
      }
      guards.push({ ...guard, beforeHash });
    }
    const token = randomUUID();
    const ticket: MutationTicket = {
      token,
      kind: plan.kind,
      repositoryFingerprint,
      sessionEpoch,
      expiresAt: new Date(
        clock.now().getTime() + (plan.expiresInMs ?? 10 * 60_000),
      ).toISOString(),
      preconditions,
      guards,
    };
    previews.set(token, { ticket, root, operations: plan.operations });
    return ticket;
  }

  async function commitMutation(
    rootInput: string,
    token: string,
    expectedKind?: string,
  ): Promise<void> {
    const root = await canonicalRoot(rootInput);
    const preview = previews.get(token);
    previews.delete(token);
    assert(preview, "INVALID_PREVIEW_TOKEN", "写入预览令牌无效或已使用", 409);
    if (expectedKind !== undefined && preview.ticket.kind !== expectedKind) {
      throw new AppError(
        "INVALID_PREVIEW_TOKEN",
        "写入预览不属于当前操作",
        409,
        { expectedKind, actualKind: preview.ticket.kind },
      );
    }
    assert(
      preview.root === root,
      "INVALID_PREVIEW_TOKEN",
      "写入预览不属于当前仓库",
      409,
    );
    assert(
      preview.ticket.sessionEpoch === (await epoch(root)),
      "INVALID_PREVIEW_TOKEN",
      "写入预览会话已失效",
      409,
    );
    assert(
      Date.parse(preview.ticket.expiresAt) > clock.now().getTime(),
      "PREVIEW_EXPIRED",
      "写入预览已过期，请重新预览",
      409,
    );
    assert(
      preview.ticket.repositoryFingerprint === (await fingerprint(root)),
      "INVALID_PREVIEW_TOKEN",
      "仓库身份已变化",
      409,
    );
    await assertRepositoryWritable(root);

    const transactionId = randomUUID();
    const ownerToken = randomUUID();
    const createdAt = clock.now().toISOString();
    const lock: LockRecord = {
      schemaVersion: 1,
      ownerToken,
      kind: "transaction",
      transactionId,
      operation: preview.ticket.kind,
      repositoryFingerprint: preview.ticket.repositoryFingerprint,
      pid: process.pid,
      acquiredAt: createdAt,
    };
    await acquireLock(root, lock);
    let journal: TransactionJournal | undefined;
    const stagedWithoutJournal: string[] = [];
    let safeToRelease = true;
    try {
      await faults.hit("lock-acquired", { transactionId });
      for (const condition of preview.ticket.preconditions) {
        const current =
          condition.kind === "remove-tree"
            ? await readRemovalTreeHash(absolute(root, condition.path))
            : condition.kind === "move-tree"
              ? await readTreeHash(absolute(root, condition.path))
              : condition.kind === "create-tree"
                ? (await files.exists(absolute(root, condition.path)))
                  ? "present"
                  : undefined
                : await readHash(absolute(root, condition.path));
        const matches =
          condition.expected === "exists"
            ? current === condition.beforeHash
            : current === undefined;
        if (!matches) {
          throw new AppError(
            "MUTATION_CONFLICT",
            "预览后目标文件已发生变化",
            409,
            { path: condition.path },
          );
        }
        if (
          (condition.kind === "move-tree" || condition.kind === "move") &&
          condition.destinationPath &&
          (await files.exists(absolute(root, condition.destinationPath)))
        ) {
          throw new AppError(
            "MUTATION_CONFLICT",
            "预览后移动目标已被占用",
            409,
            { path: condition.destinationPath },
          );
        }
      }
      for (const guard of preview.ticket.guards) {
        const current = await readGuardHash(root, guard);
        if (current !== guard.beforeHash) {
          throw new AppError(
            "MUTATION_CONFLICT",
            "预览后受观察的文件或目录已发生变化",
            409,
            { path: guard.path, guard: guard.kind },
          );
        }
      }

      const journalOperations: TransactionJournal["operations"] = [];
      for (let index = 0; index < preview.operations.length; index += 1) {
        const operation = preview.operations[index]!;
        const condition = preview.ticket.preconditions[index]!;
        const directory = path.posix.dirname(operation.path);
        const base = path.posix.basename(operation.path);
        const temporaryPath =
          operation.kind === "remove" ||
          operation.kind === "remove-tree" ||
          operation.kind === "move" ||
          operation.kind === "move-tree"
            ? undefined
            : path.posix.join(directory, `.${base}.${transactionId}.tmp`);
        const backupPath =
          operation.kind === "replace" ||
          operation.kind === "remove" ||
          operation.kind === "remove-tree"
            ? path.posix.join(directory, `.${base}.${transactionId}.bak`)
            : undefined;
        if (operation.kind === "move-tree") {
          journalOperations.push({
            kind: "move-tree",
            path: operation.path,
            destinationPath: operation.destinationPath,
            beforeHash: condition.beforeHash!,
            progress: "pending",
          });
          continue;
        }
        if (operation.kind === "move") {
          journalOperations.push({
            kind: "move",
            path: operation.path,
            destinationPath: operation.destinationPath,
            beforeHash: condition.beforeHash!,
            progress: "pending",
          });
          continue;
        }
        if (operation.kind === "create-tree") {
          const temporary = absolute(root, temporaryPath!);
          await files.mkdir(temporary);
          stagedWithoutJournal.push(temporaryPath!);
          for (const entry of operation.entries) {
            const target = path.join(temporary, ...entry.path.split("/"));
            if (entry.kind === "directory") await files.mkdir(target);
            else await files.writeExclusive(target, entry.content);
          }
          journalOperations.push({
            kind: "create-tree",
            path: operation.path,
            temporaryPath: temporaryPath!,
            afterHash: await files.snapshotDirectory(temporary),
            progress: "pending",
          });
          continue;
        }
        if (operation.kind === "remove" || operation.kind === "remove-tree") {
          journalOperations.push({
            kind: operation.kind,
            path: operation.path,
            backupPath: backupPath!,
            beforeHash: condition.beforeHash!,
            progress: "pending",
          });
        } else {
          await files.writeExclusive(
            absolute(root, temporaryPath!),
            operationContent(operation),
          );
          stagedWithoutJournal.push(temporaryPath!);
          if (operation.kind === "replace") {
            journalOperations.push({
              kind: "replace",
              path: operation.path,
              temporaryPath: temporaryPath!,
              backupPath: backupPath!,
              beforeHash: condition.beforeHash!,
              afterHash: condition.afterHash!,
              progress: "pending",
            });
          } else {
            journalOperations.push({
              kind: "create",
              path: operation.path,
              temporaryPath: temporaryPath!,
              afterHash: condition.afterHash!,
              progress: "pending",
            });
          }
        }
      }
      await faults.hit("temps-staged", { transactionId });
      journal = {
        schemaVersion: 2,
        transactionId,
        token,
        kind: preview.ticket.kind,
        repositoryFingerprint: preview.ticket.repositoryFingerprint,
        sessionEpoch: preview.ticket.sessionEpoch,
        phase: "prepared",
        createdAt,
        updatedAt: createdAt,
        operations: journalOperations,
      };
      await saveJournal(root, journal);
      stagedWithoutJournal.length = 0;
      await faults.hit("journal-prepared", { transactionId });
      journal.phase = "committing";
      await saveJournal(root, journal);
      await faults.hit("journal-committing", { transactionId });

      for (let index = 0; index < journal.operations.length; index += 1) {
        const operation = journal.operations[index]!;
        const target = absolute(root, operation.path);
        if (
          operation.kind === "replace" ||
          operation.kind === "remove" ||
          operation.kind === "remove-tree"
        ) {
          await faults.hit("operation-before-backup", {
            transactionId,
            index,
            path: operation.path,
            kind: operation.kind,
          });
          const hash =
            operation.kind === "remove-tree" ? readRemovalTreeHash : readHash;
          await files.rename(target, absolute(root, operation.backupPath));
          assert(
            (await hash(absolute(root, operation.backupPath))) ===
              operation.beforeHash,
            "MUTATION_CONFLICT",
            "目标文件在安装前发生变化",
            409,
          );
          operation.progress = "backed-up";
          await saveJournal(root, journal);
          await faults.hit("operation-after-backup", {
            transactionId,
            index,
            path: operation.path,
            kind: operation.kind,
          });
        }
        if (operation.kind === "move-tree") {
          operation.movedHash = await readTreeHash(target);
          assert(
            operation.movedHash,
            "MUTATION_CONFLICT",
            "待移动目录树在安装前不存在",
            409,
          );
          await saveJournal(root, journal);
          await faults.hit("operation-before-install", {
            transactionId,
            index,
            path: operation.path,
            destinationPath: operation.destinationPath,
            kind: operation.kind,
          });
          await files.rename(target, absolute(root, operation.destinationPath));
          await faults.hit("operation-after-tree-rename", {
            transactionId,
            index,
            path: operation.path,
            destinationPath: operation.destinationPath,
            kind: operation.kind,
          });
          operation.progress = "installed";
          await saveJournal(root, journal);
          await faults.hit("operation-after-install", {
            transactionId,
            index,
            path: operation.path,
            destinationPath: operation.destinationPath,
            kind: operation.kind,
          });
          continue;
        }
        if (operation.kind === "move") {
          await faults.hit("operation-before-install", {
            transactionId,
            index,
            path: operation.path,
            destinationPath: operation.destinationPath,
            kind: operation.kind,
          });
          await files.rename(target, absolute(root, operation.destinationPath));
          operation.progress = "installed";
          await saveJournal(root, journal);
          await faults.hit("operation-after-install", {
            transactionId,
            index,
            path: operation.path,
            destinationPath: operation.destinationPath,
            kind: operation.kind,
          });
          continue;
        }
        if (operation.kind === "remove" || operation.kind === "remove-tree") {
          operation.progress = "installed";
          await saveJournal(root, journal);
          await faults.hit("operation-after-install", {
            transactionId,
            index,
            path: operation.path,
            kind: operation.kind,
          });
          continue;
        }
        await faults.hit("operation-before-install", {
          transactionId,
          index,
          path: operation.path,
          kind: operation.kind,
        });
        if (operation.kind === "create") {
          await files.installCreate(
            absolute(root, operation.temporaryPath),
            target,
          );
        } else {
          await files.rename(absolute(root, operation.temporaryPath), target);
        }
        if (operation.kind === "create-tree") {
          assert(
            (await readTreeHash(target)) === operation.afterHash,
            "MUTATION_VERIFY_FAILED",
            "目录树安装后的哈希校验失败",
            500,
          );
        }
        operation.progress = "installed";
        await saveJournal(root, journal);
        await faults.hit("operation-after-install", {
          transactionId,
          index,
          path: operation.path,
          kind: operation.kind,
        });
      }
      for (const operation of journal.operations) {
        if (operation.kind === "move-tree") {
          const installedHash = operation.movedHash ?? operation.beforeHash;
          assert(
            (await readTreeHash(absolute(root, operation.path))) ===
              undefined &&
              (await readTreeHash(
                absolute(root, operation.destinationPath),
              )) === installedHash,
            "MUTATION_VERIFY_FAILED",
            "事务写入后的目录树哈希校验失败",
            500,
          );
          continue;
        }
        if (operation.kind === "move") {
          assert(
            (await readHash(absolute(root, operation.path))) === undefined &&
              (await readHash(absolute(root, operation.destinationPath))) ===
                operation.beforeHash,
            "MUTATION_VERIFY_FAILED",
            "事务写入后的文件移动校验失败",
            500,
          );
          continue;
        }
        if (operation.kind === "create-tree") {
          assert(
            await files.exists(absolute(root, operation.path)),
            "MUTATION_VERIFY_FAILED",
            "事务写入后的目录树不存在",
            500,
          );
          continue;
        }
        const hash =
          operation.kind === "remove-tree" ? readRemovalTreeHash : readHash;
        const expectedHash =
          operation.kind === "remove" || operation.kind === "remove-tree"
            ? undefined
            : operation.afterHash;
        assert(
          (await hash(
            absolute(root, relocatedPath(journal, operation.path)),
          )) === expectedHash,
          "MUTATION_VERIFY_FAILED",
          "事务写入后的文件哈希校验失败",
          500,
        );
      }
      await faults.hit("before-committed-journal", { transactionId });
      journal.phase = "committed";
      await saveJournal(root, journal);
      await faults.hit("after-committed-journal", { transactionId });
      await cleanArtifacts(root, journal).catch(async (error) => {
        journal!.error = `提交成功，清理待恢复：${errorMessage(error)}`;
        await saveJournal(root, journal!).catch(() => undefined);
      });
    } catch (error) {
      if (error instanceof SimulatedMutationCrash) {
        safeToRelease = false;
        throw error;
      }
      if (journal?.phase === "committed") throw error;
      if (journal) {
        try {
          await rollBack(root, journal);
          journal.phase = "rolled-back";
          journal.error = errorMessage(error);
          await saveJournal(root, journal);
          await cleanArtifacts(root, journal);
        } catch (rollbackError) {
          safeToRelease = false;
          await markRecoveryRequired(root, journal, rollbackError);
          throw new AppError(
            "MUTATION_RECOVERY_REQUIRED",
            "事务回滚未能完成，已保留现场并阻断后续写入",
            503,
            {
              cause: errorMessage(error),
              rollback: errorMessage(rollbackError),
            },
          );
        }
      }
      for (const temporaryPath of stagedWithoutJournal) {
        await files
          .remove(absolute(root, temporaryPath))
          .catch(() => undefined);
      }
      throw error;
    } finally {
      if (safeToRelease)
        await releaseLock(root, ownerToken).catch(() => undefined);
    }
  }

  async function assertRepositoryWritable(rootInput: string): Promise<void> {
    const root = await canonicalRoot(rootInput);
    if (await files.exists(recoveryMarkerPath(root))) {
      throw new AppError(
        "MUTATION_RECOVERY_REQUIRED",
        "小说仓库存在需要人工恢复的旧写入",
        503,
      );
    }
    const journals = await loadJournals(root);
    const blocked = journals.filter(
      (journal) => journal.phase === "recovery-required",
    );
    if (blocked.length > 0) {
      throw new AppError(
        "MUTATION_RECOVERY_REQUIRED",
        "小说仓库存在需要人工恢复的事务",
        503,
        { transactions: blocked.map((journal) => journal.transactionId) },
      );
    }
    if (await files.exists(lockPath(root))) {
      throw new AppError(
        "REPOSITORY_LOCKED",
        "小说仓库存在未释放的写入锁",
        409,
      );
    }
  }

  async function withRepositoryWriteGuard<T>(
    rootInput: string,
    operation: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const root = await canonicalRoot(rootInput);
    await assertRepositoryWritable(root);
    const ownerToken = randomUUID();
    const record: LockRecord = {
      schemaVersion: 1,
      ownerToken,
      kind: "guard",
      operation,
      repositoryFingerprint: await fingerprint(root),
      pid: process.pid,
      acquiredAt: clock.now().toISOString(),
    };
    await acquireLock(root, record);
    try {
      return await action();
    } finally {
      await releaseLock(root, ownerToken).catch(() => undefined);
    }
  }

  async function recoverMutationRepository(
    rootInput: string,
  ): Promise<RecoveryResult> {
    const root = await canonicalRoot(rootInput);
    const result: RecoveryResult = {
      recovered: [],
      cleaned: [],
      recoveryRequired: [],
    };
    if (await files.exists(recoveryMarkerPath(root))) {
      result.recoveryRequired.push("repository");
      return result;
    }
    const repositoryFingerprint = await fingerprint(root);
    let lock: LockRecord | undefined;
    if (await files.exists(lockPath(root))) {
      lock = await readLock(root);
      assert(
        lock.repositoryFingerprint === repositoryFingerprint,
        "MUTATION_RECOVERY_REQUIRED",
        "写入锁不属于当前仓库，需要人工恢复",
        503,
      );
      if (await liveness.isAlive(lock.pid)) {
        throw new AppError(
          "REPOSITORY_LOCKED",
          "小说仓库正在由活动进程写入",
          409,
        );
      }
      if (lock.kind === "guard") {
        await markRepositoryRecoveryRequired(root, {
          operation: lock.operation,
          reason: "服务在非事务写入期间中断，无法自动证明文件一致性",
        });
        throw new AppError(
          "MUTATION_RECOVERY_REQUIRED",
          "旧写入在进程中断时未完成，需要人工检查",
          503,
        );
      }
    }

    const journals = await loadJournals(root);
    if (
      lock?.kind === "transaction" &&
      !journals.some((journal) => journal.transactionId === lock!.transactionId)
    ) {
      await markRepositoryRecoveryRequired(root, {
        operation: lock.operation,
        transactionId: lock.transactionId,
        reason: "事务锁缺少匹配日志，无法自动恢复",
      });
      throw new AppError(
        "MUTATION_RECOVERY_REQUIRED",
        "事务锁缺少匹配日志，需要人工恢复",
        503,
      );
    }
    for (const journal of journals) {
      if (journal.repositoryFingerprint !== repositoryFingerprint) {
        result.recoveryRequired.push(journal.transactionId);
        continue;
      }
      if (journal.phase === "recovery-required") {
        result.recoveryRequired.push(journal.transactionId);
        continue;
      }
      try {
        if (journal.phase === "committed" || journal.phase === "rolled-back") {
          await cleanArtifacts(root, journal);
          result.cleaned.push(journal.transactionId);
        } else {
          await rollBack(root, journal);
          journal.phase = "rolled-back";
          await saveJournal(root, journal);
          await cleanArtifacts(root, journal);
          result.recovered.push(journal.transactionId);
        }
      } catch (error) {
        await markRecoveryRequired(root, journal, error);
        result.recoveryRequired.push(journal.transactionId);
      }
    }
    if (result.recoveryRequired.length === 0 && lock)
      await releaseLock(root, lock.ownerToken);
    return result;
  }

  async function invalidateMutationPreviews(rootInput?: string): Promise<void> {
    if (!rootInput) {
      previews.clear();
      epochs.clear();
      return;
    }
    const root = await canonicalRoot(rootInput);
    for (const [token, preview] of previews) {
      if (preview.root === root) previews.delete(token);
    }
    epochs.set(root, randomUUID());
  }

  function discardMutationPreview(token: string): void {
    previews.delete(token);
  }

  return {
    prepareMutation,
    commitMutation,
    withRepositoryWriteGuard,
    discardMutationPreview,
    invalidateMutationPreviews,
    recoverMutationRepository,
    assertRepositoryWritable,
  };
}

const defaultEngine = createMutationEngine();

export const prepareMutation = defaultEngine.prepareMutation;
export const commitMutation = defaultEngine.commitMutation;
export const withRepositoryWriteGuard = defaultEngine.withRepositoryWriteGuard;
export const discardMutationPreview = defaultEngine.discardMutationPreview;
export const invalidateMutationPreviews =
  defaultEngine.invalidateMutationPreviews;
export const recoverMutationRepository =
  defaultEngine.recoverMutationRepository;
export const assertRepositoryWritable = defaultEngine.assertRepositoryWritable;
