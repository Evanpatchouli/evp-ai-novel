import { readFile } from "node:fs/promises";
import { diffLines } from "diff";
import yaml from "js-yaml";
import type {
  NovelMetadataCommitResult,
  NovelMetadataDetail,
  NovelMetadataPreview,
  TextChange,
} from "../shared/contracts.js";
import { AppError, assert } from "./errors.js";
import { resolveInside, sha256 } from "./files.js";
import {
  commitMutation,
  discardMutationPreview,
  prepareMutation,
  type MutationPlan,
} from "./mutations/index.js";
import {
  NOVEL_COVER_PATH,
  NovelCoverUploadSchema,
  NovelMetadataSchema,
} from "./repository-domain.js";
import { readRepositoryIndex } from "./repository.js";

const NOVEL_PATH = "00_项目/小说.yaml" as const;

interface NovelMetadataInput {
  title: string;
  author: string;
  description: string;
  coverUpload?: {
    name: string;
    mimeType: "image/png";
    contentBase64: string;
  };
  currentVolume?: string;
  currentChapter?: string;
  expectedHash?: string;
}

interface PendingNovelMetadataMutation {
  kind: "create" | "edit";
  confirmationRequirements: string[];
}

const pendingMutations = new Map<string, PendingNovelMetadataMutation>();

function defaultMetadata() {
  return NovelMetadataSchema.parse({
    schema_version: 1,
    novel: {
      id: "novel",
      title: "示例小说",
      author: "",
      description: "",
    },
  });
}

function textDiff(before: string, after: string): TextChange[] {
  return diffLines(before, after).map((part) => ({
    type: part.added ? "added" : part.removed ? "removed" : "unchanged",
    value: part.value,
    count: part.count,
  }));
}

/** 读取可选小说元数据；文件缺失时返回兼容默认值且不落盘。 */
export async function readNovelMetadata(
  root: string,
): Promise<NovelMetadataDetail> {
  let content: string;
  try {
    content = await readFile(resolveInside(root, NOVEL_PATH), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, path: NOVEL_PATH, metadata: defaultMetadata() };
    }
    throw error;
  }
  let raw: unknown;
  try {
    raw = yaml.load(content);
  } catch (error) {
    throw new AppError("YAML_PARSE_ERROR", "小说元数据 YAML 无法解析", 409, {
      details: error instanceof Error ? error.message : String(error),
    });
  }
  const parsed = NovelMetadataSchema.safeParse(raw);
  if (!parsed.success)
    throw new AppError(
      "INVALID_NOVEL_METADATA",
      "小说元数据不符合 schema_version 1",
      409,
      parsed.error.issues,
    );
  return {
    exists: true,
    path: NOVEL_PATH,
    sourceHash: sha256(content),
    metadata: parsed.data,
  };
}

async function validateCurrentLocation(
  root: string,
  input: NovelMetadataInput,
) {
  assert(
    !input.currentChapter || input.currentVolume,
    "INVALID_NOVEL_LOCATION",
    "当前章节必须同时指定当前卷",
  );
  if (!input.currentVolume) return;
  const index = await readRepositoryIndex(root);
  const volume = index.volumes.find((item) => item.id === input.currentVolume);
  assert(volume, "INVALID_NOVEL_LOCATION", "当前卷不存在", 409);
  if (input.currentChapter) {
    assert(
      volume.chapters.some((chapter) => chapter.id === input.currentChapter),
      "INVALID_NOVEL_LOCATION",
      "当前章节不存在或不属于当前卷",
      409,
    );
  }
}

/** 预览结构化创建或修改 `00_项目/小说.yaml`。 */
export async function prepareNovelMetadata(
  root: string,
  input: NovelMetadataInput,
): Promise<NovelMetadataPreview> {
  const coverUpload = input.coverUpload
    ? NovelCoverUploadSchema.safeParse(input.coverUpload)
    : undefined;
  if (coverUpload && !coverUpload.success) {
    throw new AppError(
      "INVALID_NOVEL_COVER",
      "封面必须是有效且不超过 5 MiB 的 PNG 文件",
      400,
      coverUpload.error.issues,
    );
  }
  await validateCurrentLocation(root, input);
  const current = await readNovelMetadata(root);
  if (current.exists) {
    assert(
      input.expectedHash,
      "EXPECTED_HASH_REQUIRED",
      "修改小说元数据必须提供旧哈希",
    );
    assert(
      current.sourceHash === input.expectedHash,
      "NOVEL_METADATA_CONFLICT",
      "小说元数据已被外部修改",
      409,
    );
  } else {
    assert(
      !input.expectedHash,
      "NOVEL_METADATA_CONFLICT",
      "小说元数据尚不存在，不能提供旧哈希",
      409,
    );
  }
  const document = NovelMetadataSchema.parse({
    schema_version: 1,
    novel: {
      id: current.metadata.novel.id,
      title: input.title,
      author: input.author,
      description: input.description,
      ...(coverUpload?.success
        ? { cover: NOVEL_COVER_PATH }
        : current.metadata.novel.cover
          ? { cover: current.metadata.novel.cover }
          : {}),
      ...(input.currentVolume ? { current_volume: input.currentVolume } : {}),
      ...(input.currentChapter
        ? { current_chapter: input.currentChapter }
        : {}),
    },
  });
  const before = current.exists
    ? await readFile(resolveInside(root, NOVEL_PATH), "utf8")
    : "";
  const content = yaml.dump(document, { noRefs: true, lineWidth: 120 });
  assert(
    before !== content || coverUpload?.success,
    "NO_NOVEL_METADATA_CHANGES",
    "小说元数据没有变化",
  );
  const kind = current.exists ? "edit" : "create";
  const operations: MutationPlan["operations"] = [];
  let coverAction: "创建" | "替换" | undefined;
  if (coverUpload?.success) {
    const coverExists = await readFile(resolveInside(root, NOVEL_COVER_PATH))
      .then(() => true)
      .catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      });
    coverAction = coverExists ? "替换" : "创建";
    operations.push({
      kind: coverExists ? "replace" : "create",
      path: NOVEL_COVER_PATH,
      content: coverUpload.data.contentBase64,
      encoding: "base64",
    });
  }
  operations.push({
    kind: current.exists ? "replace" : "create",
    path: NOVEL_PATH,
    content,
  });
  const ticket = await prepareMutation(root, {
    kind: `novel-metadata-${kind}`,
    guards: current.exists
      ? []
      : [{ kind: "directory-snapshot", path: "00_项目" }],
    operations,
  });
  const confirmationRequirements = [`confirm-novel-metadata-${kind}`];
  pendingMutations.set(ticket.token, { kind, confirmationRequirements });
  return {
    token: ticket.token,
    kind,
    expiresAt: ticket.expiresAt,
    targetPath: NOVEL_PATH,
    diff: textDiff(before, content),
    plannedChanges: [
      ...(coverAction ? [`${coverAction} ${NOVEL_COVER_PATH}`] : []),
      `${kind === "create" ? "创建" : "更新"} ${NOVEL_PATH}`,
    ],
    referenceImpacts: [],
    confirmationRequirements,
    destinationHref: "/novel",
  };
}

export function hasPendingNovelMetadataMutation(token: string): boolean {
  return pendingMutations.has(token);
}

/** 提交已确认的小说元数据 mutation。 */
export async function commitNovelMetadataMutation(
  root: string,
  token: string,
  confirmationKeys: readonly string[],
): Promise<NovelMetadataCommitResult> {
  const pending = pendingMutations.get(token);
  pendingMutations.delete(token);
  assert(
    pending,
    "INVALID_PREVIEW_TOKEN",
    "小说元数据预览令牌无效或已使用",
    409,
  );
  const confirmed = new Set(confirmationKeys);
  if (!pending.confirmationRequirements.every((key) => confirmed.has(key))) {
    discardMutationPreview(token);
    throw new AppError(
      "MUTATION_CONFIRMATION_REQUIRED",
      "必须确认预览中的全部变更项后才能提交",
      409,
      {
        required: pending.confirmationRequirements,
        received: [...confirmed],
      },
    );
  }
  await commitMutation(root, token);
  return {
    kind: pending.kind,
    destinationHref: "/novel",
    novel: await readNovelMetadata(root),
  };
}
