import { z } from "zod";

export const mutationPhaseSchema = z.enum([
  "prepared",
  "committing",
  "committed",
  "rolled-back",
  "recovery-required",
]);

export type MutationPhase = z.infer<typeof mutationPhaseSchema>;

const repositoryPathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.includes("\\") &&
      !value.startsWith("/") &&
      !value.startsWith(".workbench/") &&
      !value
        .split("/")
        .some((part) => part === "" || part === "." || part === ".."),
    "必须是仓库内的安全 POSIX 相对路径",
  );

const treeEntryPathSchema = repositoryPathSchema.refine(
  (value) => !value.includes("/../") && !value.startsWith("../"),
  "必须是目录树内的安全相对路径",
);

const treeEntrySchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("directory"), path: treeEntryPathSchema })
    .strict(),
  z
    .object({
      kind: z.literal("file"),
      path: treeEntryPathSchema,
      content: z.string(),
    })
    .strict(),
]);

export const mutationOperationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("replace"),
      path: repositoryPathSchema,
      content: z.string(),
      encoding: z.enum(["utf8", "base64"]).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("create"),
      path: repositoryPathSchema,
      content: z.string(),
      encoding: z.enum(["utf8", "base64"]).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("remove"),
      path: repositoryPathSchema,
    })
    .strict(),
  z
    .object({ kind: z.literal("remove-tree"), path: repositoryPathSchema })
    .strict(),
  z
    .object({
      kind: z.literal("move"),
      path: repositoryPathSchema,
      destinationPath: repositoryPathSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("create-tree"),
      path: repositoryPathSchema,
      entries: z.array(treeEntrySchema).max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal("move-tree"),
      path: repositoryPathSchema,
      destinationPath: repositoryPathSchema,
    })
    .strict(),
]);

export type MutationOperation = z.infer<typeof mutationOperationSchema>;

export const mutationGuardSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("file-hash"),
      path: repositoryPathSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("directory-snapshot"),
      path: repositoryPathSchema,
    })
    .strict(),
]);

export type MutationGuard = z.infer<typeof mutationGuardSchema>;

export const mutationPlanSchema = z
  .object({
    kind: z.string().min(1).max(100),
    operations: z.array(mutationOperationSchema).min(1),
    guards: z.array(mutationGuardSchema).default([]),
    expiresInMs: z
      .number()
      .int()
      .positive()
      .max(60 * 60_000)
      .optional(),
  })
  .strict();

export type MutationPlan = z.input<typeof mutationPlanSchema>;

export interface MutationPrecondition {
  kind: MutationOperation["kind"];
  path: string;
  expected: "exists" | "absent";
  beforeHash?: string;
  afterHash?: string;
  destinationPath?: string;
}

export interface MutationGuardPrecondition {
  kind: "file-hash" | "directory-snapshot";
  path: string;
  beforeHash: string;
}

export interface MutationTicket {
  token: string;
  kind: string;
  repositoryFingerprint: string;
  sessionEpoch: string;
  expiresAt: string;
  preconditions: MutationPrecondition[];
  guards: MutationGuardPrecondition[];
}

const journalProgressSchema = z.enum(["pending", "backed-up", "installed"]);

const journalOperationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("replace"),
      path: repositoryPathSchema,
      temporaryPath: repositoryPathSchema,
      backupPath: repositoryPathSchema,
      beforeHash: z.string().length(64),
      afterHash: z.string().length(64),
      progress: journalProgressSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("create"),
      path: repositoryPathSchema,
      temporaryPath: repositoryPathSchema,
      afterHash: z.string().length(64),
      progress: journalProgressSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("remove"),
      path: repositoryPathSchema,
      backupPath: repositoryPathSchema,
      beforeHash: z.string().length(64),
      progress: journalProgressSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("remove-tree"),
      path: repositoryPathSchema,
      backupPath: repositoryPathSchema,
      beforeHash: z.string().length(64),
      progress: journalProgressSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("move"),
      path: repositoryPathSchema,
      destinationPath: repositoryPathSchema,
      beforeHash: z.string().length(64),
      progress: journalProgressSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("create-tree"),
      path: repositoryPathSchema,
      temporaryPath: repositoryPathSchema,
      afterHash: z.string().length(64),
      progress: journalProgressSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("move-tree"),
      path: repositoryPathSchema,
      destinationPath: repositoryPathSchema,
      beforeHash: z.string().length(64),
      movedHash: z.string().length(64).optional(),
      progress: journalProgressSchema,
    })
    .strict(),
]);

export const transactionJournalSchema = z
  .object({
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    transactionId: z.string().uuid(),
    token: z.string().uuid(),
    kind: z.string().min(1).max(100),
    repositoryFingerprint: z.string().length(64),
    sessionEpoch: z.string().uuid(),
    phase: mutationPhaseSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    operations: z.array(journalOperationSchema).min(1),
    error: z.string().max(2_000).optional(),
  })
  .strict();

export type TransactionJournal = z.infer<typeof transactionJournalSchema>;

export interface RecoveryResult {
  recovered: string[];
  cleaned: string[];
  recoveryRequired: string[];
}
