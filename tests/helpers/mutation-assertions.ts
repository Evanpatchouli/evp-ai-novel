import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { expect } from "vitest";
import {
  transactionJournalSchema,
  type TransactionJournal,
} from "../../server/mutations/index.js";

export async function readMutationJournals(
  root: string,
): Promise<TransactionJournal[]> {
  const directory = path.join(root, ".workbench", "transactions");
  const names = await readdir(directory).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  return Promise.all(
    names
      .filter((name) => name.endsWith(".yaml"))
      .sort()
      .map(async (name) =>
        transactionJournalSchema.parse(
          yaml.load(await readFile(path.join(directory, name), "utf8")),
        ),
      ),
  );
}

export async function listMutationArtifacts(root: string): Promise<string[]> {
  const workspace = path.join(root, ".workbench");
  const visit = async (directory: string): Promise<string[]> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) return visit(absolute);
        return [path.relative(workspace, absolute).split(path.sep).join("/")];
      }),
    );
    return nested.flat().sort();
  };
  return visit(workspace);
}

export async function expectNoTransientMutationArtifacts(root: string) {
  const artifacts = await listMutationArtifacts(root);
  expect(artifacts).not.toContain("write.lock");
  expect(
    artifacts.filter((name) => name.endsWith(".tmp") || name.endsWith(".bak")),
  ).toEqual([]);
}
