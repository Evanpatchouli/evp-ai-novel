import { readFile } from "node:fs/promises";
import fg from "fast-glob";
import { z } from "zod";
import { AppError } from "./errors.js";
import { resolveInside } from "./files.js";
import type { MutationOperation } from "./mutations/index.js";
import { VolumeIdSchema } from "./repository-domain.js";

const directory = "00_项目/删除记录";
const schema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("chapter"),
    lastChapterNumber: z.int().positive(),
  }),
  z.object({
    kind: z.literal("volume"),
    volumeId: VolumeIdSchema,
    volumeNumber: z.int().positive(),
    lastChapterNumber: z.int().nonnegative(),
  }),
]);

type DeletedIdentity = z.infer<typeof schema>;

export function recordDeletion(identity: DeletedIdentity): MutationOperation {
  const key =
    identity.kind === "volume"
      ? `volume-${identity.volumeId}`
      : `chapter-${identity.lastChapterNumber}`;
  return {
    kind: "create",
    path: `${directory}/${key}.json`,
    content: `${JSON.stringify(identity)}\n`,
  };
}

export async function readDeletionHistory(
  root: string,
): Promise<DeletedIdentity[]> {
  const paths = await fg(`${directory}/*.json`, { cwd: root, onlyFiles: true });
  return Promise.all(
    paths.map(async (relative) => {
      try {
        const content = await readFile(resolveInside(root, relative), "utf8");
        return schema.parse(JSON.parse(content));
      } catch {
        throw new AppError(
          "INVALID_DELETION_HISTORY",
          `删除记录无法读取：${relative}`,
          409,
        );
      }
    }),
  );
}
