import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { diffLines } from "diff";
import fg from "fast-glob";
import yaml from "js-yaml";
import type {
  ChapterArchiveEntry,
  ChapterCreateDefaults,
  ChapterMutationCommitResult,
  ChapterMutationKind,
  ChapterMutationPreview,
  ChapterReferenceImpact,
  TextChange,
} from "../shared/contracts.js";
import {
  analyzeChapterMarkdown,
  normalizeChapterLineEndings,
} from "../shared/chapter-text.js";
import { chapterHref } from "../shared/reader-paths.js";
import { validateChapterContent } from "./chapter-content.js";
import { readDeletionHistory, recordDeletion } from "./deletion-history.js";
import { AppError, assert } from "./errors.js";
import { resolveInside, sha256 } from "./files.js";
import {
  commitMutation,
  discardMutationPreview,
  prepareMutation,
} from "./mutations/index.js";
import {
  ArchiveManifestSchema,
  compactChapterStatuses,
  expandStatusRanges,
  formatChapterId,
  parseChapterId,
  parseVolumeStatusYaml,
  type ArchiveManifest,
  type ChapterStatusMetadata,
  type VolumeStatusDocument,
} from "./repository-domain.js";
import {
  invalidateRepositoryReadModel,
  readChapterDetail,
  readRepositoryIndex,
} from "./repository.js";

const ARCHIVE_ROOT = "99_归档/工作台回收站";

interface ChapterIdentity {
  volumeId: string;
  chapterId: string;
}

interface PendingChapterMutation extends ChapterIdentity {
  kind: ChapterMutationKind;
  destinationHref: string;
  archiveId?: string;
  confirmationRequirements: string[];
}

interface ChapterEditInput extends ChapterIdentity {
  content: string;
  expectedHash?: string;
}

interface ChapterCreateInput {
  volumeId: string;
  content: string;
}

interface ChapterArchiveInput extends ChapterIdentity {
  reason: string;
  expectedHash?: string;
  confirmFinal?: boolean;
}

interface ChapterRestoreInput {
  archiveId: string;
}

interface LoadedVolumeStatus {
  path: string;
  content: string;
  document: VolumeStatusDocument;
  statuses: Map<number, ChapterStatusMetadata>;
}

const pendingMutations = new Map<string, PendingChapterMutation>();

function textDiff(before: string, after: string): TextChange[] {
  return diffLines(before, after).map((part) => ({
    type: part.added ? "added" : part.removed ? "removed" : "unchanged",
    value: part.value,
    count: part.count,
  }));
}

function normalizedPathIdentity(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

async function assertRestoreTargetAvailable(
  root: string,
  targetPath: string,
): Promise<void> {
  const targetIdentity = normalizedPathIdentity(targetPath);
  const currentChapterPaths = await fg("40_正文/卷/*/**/*.md", {
    cwd: root,
    onlyFiles: true,
  });
  assert(
    !currentChapterPaths.some(
      (candidate) => normalizedPathIdentity(candidate) === targetIdentity,
    ),
    "RESTORE_TARGET_OCCUPIED",
    "恢复目标路径已被占用，拒绝覆盖",
    409,
  );
}

function assertSafeArchiveId(value: string): void {
  assert(
    /^[0-9TZ.-]+-[a-f0-9-]{36}$/i.test(value),
    "INVALID_ARCHIVE_ID",
    "归档 ID 不合法",
  );
}

async function loadVolumeStatus(
  root: string,
  volumeId: string,
): Promise<LoadedVolumeStatus> {
  const relative = `40_正文/卷/${volumeId}/状态.yaml`;
  let content: string;
  try {
    content = await readFile(resolveInside(root, relative), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AppError("VOLUME_NOT_FOUND", "卷不存在", 404);
    }
    throw error;
  }
  const parsed = parseVolumeStatusYaml(content, relative);
  assert(
    parsed.document && parsed.issues.length === 0,
    "INVALID_VOLUME_STATUS",
    "卷状态文件存在阻断问题，不能写入",
    409,
  );
  assert(
    parsed.document.volume.id === volumeId,
    "VOLUME_DIRECTORY_MISMATCH",
    "卷 ID 与目录不一致",
    409,
  );
  const expanded = expandStatusRanges(
    parsed.document.status_ranges,
    relative,
    volumeId,
  );
  assert(
    expanded.issues.length === 0,
    "INVALID_VOLUME_STATUS",
    "章节状态范围存在阻断问题，不能写入",
    409,
  );
  return {
    path: relative,
    content,
    document: parsed.document,
    statuses: expanded.statuses,
  };
}

function serializeVolumeStatus(
  source: LoadedVolumeStatus,
  statuses: ReadonlyMap<number, ChapterStatusMetadata>,
  chapterCount: number,
): string {
  return yaml.dump(
    {
      ...source.document,
      volume: { ...source.document.volume, chapter_count: chapterCount },
      status_ranges: compactChapterStatuses(statuses),
    },
    { noRefs: true, lineWidth: 120 },
  );
}

async function sourceChapter(
  root: string,
  volumeId: string,
  chapterId: string,
) {
  const index = await readRepositoryIndex(root);
  assert(
    !index.health.issues.some((issue) => issue.severity === "blocking"),
    "REPOSITORY_HEALTH_BLOCKING",
    "仓库存在阻断级健康问题，不能修改章节",
    409,
  );
  const volume = index.volumes.find((item) => item.id === volumeId);
  const chapter = volume?.chapters.find((item) => item.id === chapterId);
  assert(volume && chapter, "CHAPTER_NOT_FOUND", "章节不存在", 404);
  const content = await readFile(resolveInside(root, chapter.path), "utf8");
  return { volume, chapter, content, hash: sha256(content) };
}

async function archiveManifests(root: string) {
  const paths = await fg(`${ARCHIVE_ROOT}/*/manifest.yaml`, {
    cwd: root,
    onlyFiles: true,
  });
  const manifests: Array<{
    id: string;
    path: string;
    document: ArchiveManifest;
  }> = [];
  for (const manifestPath of paths.sort()) {
    const parsed = ArchiveManifestSchema.safeParse(
      yaml.load(await readFile(resolveInside(root, manifestPath), "utf8")),
    );
    assert(
      parsed.success,
      "INVALID_ARCHIVE_MANIFEST",
      `归档清单损坏：${manifestPath}`,
      409,
    );
    manifests.push({
      id: path.posix.basename(path.posix.dirname(manifestPath)),
      path: manifestPath,
      document: parsed.data,
    });
  }
  return manifests;
}

async function nextChapterNumber(root: string): Promise<number> {
  const index = await readRepositoryIndex(root);
  assert(
    !index.health.issues.some((issue) => issue.severity === "blocking"),
    "REPOSITORY_HEALTH_BLOCKING",
    "仓库存在阻断级健康问题，不能新建章节",
    409,
  );
  let maximum = 0;
  for (const volume of index.volumes) {
    for (const chapter of volume.chapters)
      maximum = Math.max(maximum, chapter.number);
  }
  for (const { document } of await archiveManifests(root)) {
    if (document.asset_type !== "chapter") continue;
    const number = document.chapter_state
      ? parseChapterId(document.chapter_state.chapter_id)
      : parseChapterId(path.posix.basename(document.original_path, ".md"));
    if (number !== null) maximum = Math.max(maximum, number);
  }
  for (const entry of await readDeletionHistory(root))
    maximum = Math.max(maximum, entry.lastChapterNumber);
  assert(
    Number.isSafeInteger(maximum + 1),
    "CHAPTER_ID_EXHAUSTED",
    "无法生成新的章 ID",
    409,
  );
  return maximum + 1;
}

async function chapterIdentityGuards(root: string) {
  const statusPaths = await fg("40_正文/卷/*/状态.yaml", {
    cwd: root,
    onlyFiles: true,
  });
  const directories = new Set<string>([ARCHIVE_ROOT]);
  for (const statusPath of statusPaths) {
    const parsed = parseVolumeStatusYaml(
      await readFile(resolveInside(root, statusPath), "utf8"),
      statusPath,
    );
    if (!parsed.document) continue;
    directories.add(
      `${path.posix.dirname(statusPath)}/${parsed.document.canonical_root}`,
    );
  }
  return [...directories].sort().map((guardPath) => ({
    kind: "directory-snapshot" as const,
    path: guardPath,
  }));
}

async function referenceImpacts(
  root: string,
  chapterId: string,
  sourcePath: string,
): Promise<ChapterReferenceImpact[]> {
  const candidates = await fg(
    [
      "20_规划/**/*.{md,yaml,yml}",
      "30_生产/**/*.{md,yaml,yml}",
      "50_审稿/**/*.{md,yaml,yml}",
      "60_发布/**/*.{md,yaml,yml}",
    ],
    { cwd: root, onlyFiles: true, ignore: [`${ARCHIVE_ROOT}/**`] },
  );
  const impacts: ChapterReferenceImpact[] = [];
  for (const relative of candidates) {
    const content = await readFile(resolveInside(root, relative), "utf8");
    if (!content.includes(chapterId) && !content.includes(sourcePath)) continue;
    const kind = relative.startsWith("30_生产/")
      ? "production"
      : relative.startsWith("50_审稿/")
        ? "review"
        : relative.startsWith("60_发布/")
          ? "publication"
          : "planning";
    impacts.push({
      path: relative,
      kind,
      severity: relative.startsWith("30_生产/active/") ? "blocking" : "warning",
      evidence: content.includes(sourcePath) ? sourcePath : chapterId,
    });
  }
  return impacts;
}

function rememberPreview(
  preview: ChapterMutationPreview,
): ChapterMutationPreview {
  pendingMutations.set(preview.token, {
    kind: preview.kind,
    volumeId: preview.volumeId,
    chapterId: preview.chapterId,
    destinationHref: preview.destinationHref,
    archiveId: preview.archiveId,
    confirmationRequirements: preview.confirmationRequirements,
  });
  return preview;
}

/** 返回卷末新章默认值；章 ID 使用全书历史最大编号加一且永不复用。 */
export async function getChapterCreateDefaults(
  root: string,
  volumeId: string,
): Promise<ChapterCreateDefaults> {
  const volume = await loadVolumeStatus(root, volumeId);
  assert(
    volume.document.volume.status !== "archived",
    "VOLUME_ARCHIVED",
    "不能在已归档卷中新建章节",
    409,
  );
  const number = await nextChapterNumber(root);
  const chapterId = formatChapterId(number);
  return {
    volumeId,
    chapterId,
    number,
    targetPath: `40_正文/卷/${volumeId}/${volume.document.canonical_root}/${chapterId}.md`,
    initialContent: `# 第${number}章 新章节\n\n`,
  };
}

/** 预览非终稿章节的 Markdown 原文编辑。 */
export async function prepareChapterEdit(
  root: string,
  input: ChapterEditInput,
): Promise<ChapterMutationPreview> {
  const source = await sourceChapter(root, input.volumeId, input.chapterId);
  assert(
    source.chapter.status !== "final",
    "FINAL_CHAPTER_READ_ONLY",
    "终稿只能通过新一轮修订流程修改",
    409,
  );
  if (input.expectedHash) {
    assert(
      input.expectedHash === source.hash,
      "SOURCE_CHANGED",
      "章节已被外部修改，请重新读取后再预览",
      409,
    );
  }
  const currentAnalysis = validateChapterContent(source.content);
  const content = normalizeChapterLineEndings(
    input.content,
    currentAnalysis.lineEnding,
  );
  const nextAnalysis = validateChapterContent(content);
  assert(content !== source.content, "NO_CHAPTER_CHANGES", "章节内容没有变化");
  const ticket = await prepareMutation(root, {
    kind: `chapter-edit:${input.volumeId}:${input.chapterId}`,
    operations: [{ kind: "replace", path: source.chapter.path, content }],
  });
  return rememberPreview({
    token: ticket.token,
    kind: "edit",
    expiresAt: ticket.expiresAt,
    volumeId: input.volumeId,
    chapterId: input.chapterId,
    targetPath: source.chapter.path,
    beforeHash: source.hash,
    afterHash: sha256(content),
    beforeWordCount: currentAnalysis.wordCount,
    afterWordCount: nextAnalysis.wordCount,
    diff: textDiff(source.content, content),
    plannedChanges: [`修改 ${source.chapter.path}`],
    referenceImpacts: [],
    confirmationRequirements: ["confirm-content-write"],
    destinationHref: chapterHref(input.volumeId, input.chapterId),
  });
}

/** 预览在指定卷末创建章节，并同步结构化状态表。 */
export async function prepareChapterCreate(
  root: string,
  input: ChapterCreateInput,
): Promise<ChapterMutationPreview> {
  const defaults = await getChapterCreateDefaults(root, input.volumeId);
  const analysis = validateChapterContent(input.content);
  const volume = await loadVolumeStatus(root, input.volumeId);
  const statuses = new Map(volume.statuses);
  statuses.set(defaults.number, { status: "draft", humanApproved: false });
  const statusContent = serializeVolumeStatus(
    volume,
    statuses,
    volume.document.volume.chapter_count + 1,
  );
  const ticket = await prepareMutation(root, {
    kind: `chapter-create:${input.volumeId}:${defaults.chapterId}`,
    guards: await chapterIdentityGuards(root),
    operations: [
      { kind: "create", path: defaults.targetPath, content: input.content },
      { kind: "replace", path: volume.path, content: statusContent },
    ],
  });
  return rememberPreview({
    token: ticket.token,
    kind: "create",
    expiresAt: ticket.expiresAt,
    volumeId: input.volumeId,
    chapterId: defaults.chapterId,
    targetPath: defaults.targetPath,
    afterHash: sha256(input.content),
    beforeWordCount: 0,
    afterWordCount: analysis.wordCount,
    diff: textDiff("", input.content),
    plannedChanges: [`创建 ${defaults.targetPath}`, `更新 ${volume.path}`],
    referenceImpacts: [],
    confirmationRequirements: [
      "confirm-content-write",
      "confirm-status-update",
    ],
    destinationHref: chapterHref(input.volumeId, defaults.chapterId),
  });
}

/** 预览章节归档；归档通过 create + remove 组成可恢复文件事务。 */
export function prepareChapterDelete(
  root: string,
  input: ChapterIdentity & { expectedHash: string },
) {
  return prepareChapterRemoval(root, { ...input, reason: "" }, true);
}

export function prepareChapterArchive(
  root: string,
  input: ChapterArchiveInput,
) {
  return prepareChapterRemoval(root, input, false);
}

async function prepareChapterRemoval(
  root: string,
  input: ChapterArchiveInput,
  deleting: boolean,
): Promise<ChapterMutationPreview> {
  if (!deleting)
    assert(input.reason.trim(), "ARCHIVE_REASON_REQUIRED", "必须填写归档原因");
  const source = await sourceChapter(root, input.volumeId, input.chapterId);
  if (input.expectedHash) {
    assert(
      input.expectedHash === source.hash,
      "SOURCE_CHANGED",
      "章节已被外部修改，请重新读取后再预览",
      409,
    );
  }
  assert(
    deleting ||
      source.chapter.status !== "final" ||
      input.confirmFinal === true,
    "FINAL_CHAPTER_READ_ONLY",
    "归档终稿需要单独明确确认",
    409,
  );
  const impacts = await referenceImpacts(
    root,
    input.chapterId,
    source.chapter.path,
  );
  assert(
    !impacts.some((impact) => impact.severity === "blocking"),
    "CHAPTER_HAS_ACTIVE_TASK",
    `章节仍被活动生产任务引用，不能${deleting ? "删除" : "归档"}`,
    409,
  );
  const volume = await loadVolumeStatus(root, input.volumeId);
  const number = parseChapterId(input.chapterId)!;
  const metadata = volume.statuses.get(number);
  assert(metadata, "CHAPTER_STATUS_MISSING", "章节缺少状态元数据", 409);
  const statuses = new Map(volume.statuses);
  statuses.delete(number);
  const statusContent = serializeVolumeStatus(
    volume,
    statuses,
    volume.document.volume.chapter_count - 1,
  );
  const guards = [
    { kind: "directory-snapshot" as const, path: "30_生产/active" },
    ...impacts.map((impact) => ({
      kind: "file-hash" as const,
      path: impact.path,
    })),
  ];
  const operations = [
    { kind: "replace" as const, path: volume.path, content: statusContent },
    { kind: "remove" as const, path: source.chapter.path },
  ];
  const removal = {
    volumeId: input.volumeId,
    chapterId: input.chapterId,
    beforeHash: source.hash,
    beforeWordCount: source.chapter.wordCount,
    afterWordCount: 0,
    diff: textDiff(source.content, ""),
    referenceImpacts: impacts,
    destinationHref: "/chapters",
  };
  if (deleting) {
    const ticket = await prepareMutation(root, {
      kind: `chapter-delete:${input.volumeId}:${input.chapterId}`,
      guards,
      operations: [
        ...operations,
        recordDeletion({ kind: "chapter", lastChapterNumber: number }),
      ],
    });
    return rememberPreview({
      ...removal,
      token: ticket.token,
      kind: "delete",
      expiresAt: ticket.expiresAt,
      targetPath: source.chapter.path,
      plannedChanges: [
        `删除 ${source.chapter.path}`,
        `更新 ${volume.path}`,
        "记录已删除的章号",
      ],
      confirmationRequirements: [
        "confirm-chapter-delete",
        ...(source.chapter.status === "final" ? ["confirm-final-delete"] : []),
        ...(impacts.length ? ["confirm-reference-impacts"] : []),
      ],
    });
  }
  const archiveId = `${new Date().toISOString().replace(/:/g, "-")}-${randomUUID()}`;
  const archivePath = `${ARCHIVE_ROOT}/${archiveId}/${source.chapter.path}`;
  const manifestPath = `${ARCHIVE_ROOT}/${archiveId}/manifest.yaml`;
  const manifest: ArchiveManifest = {
    schema_version: 1,
    archived_at: new Date().toISOString(),
    asset_type: "chapter",
    original_path: source.chapter.path,
    archive_path: archivePath,
    reason: input.reason.trim(),
    before_hash: source.hash,
    affected_references: impacts.map((impact) => impact.path),
    restorable: true,
    chapter_state: {
      volume_id: input.volumeId,
      chapter_id: input.chapterId,
      status: metadata.status,
      human_approved: metadata.humanApproved,
      ...(metadata.reviewGate ? { review_gate: metadata.reviewGate } : {}),
      ...(metadata.note ? { note: metadata.note } : {}),
    },
  };
  const manifestContent = yaml.dump(manifest, { noRefs: true, lineWidth: 120 });
  const ticket = await prepareMutation(root, {
    kind: `chapter-archive:${input.volumeId}:${input.chapterId}`,
    guards,
    operations: [
      { kind: "create", path: archivePath, content: source.content },
      { kind: "create", path: manifestPath, content: manifestContent },
      ...operations,
    ],
  });
  return rememberPreview({
    ...removal,
    token: ticket.token,
    kind: "archive",
    expiresAt: ticket.expiresAt,
    targetPath: archivePath,
    plannedChanges: [
      `归档 ${source.chapter.path}`,
      `创建 ${manifestPath}`,
      `更新 ${volume.path}`,
    ],
    confirmationRequirements: [
      "confirm-archive",
      ...(source.chapter.status === "final" ? ["confirm-final-archive"] : []),
      ...(impacts.length ? ["confirm-reference-impacts"] : []),
    ],
    archiveId,
  });
}

async function loadArchive(root: string, archiveId: string) {
  assertSafeArchiveId(archiveId);
  const manifestPath = `${ARCHIVE_ROOT}/${archiveId}/manifest.yaml`;
  let raw: string;
  try {
    raw = await readFile(resolveInside(root, manifestPath), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AppError("ARCHIVE_NOT_FOUND", "归档不存在", 404);
    }
    throw error;
  }
  const parsed = ArchiveManifestSchema.safeParse(yaml.load(raw));
  assert(
    parsed.success &&
      parsed.data.asset_type === "chapter" &&
      parsed.data.chapter_state,
    "INVALID_ARCHIVE_MANIFEST",
    "章节归档清单损坏或缺少恢复元数据",
    409,
  );
  return { manifestPath, raw, document: parsed.data };
}

/** 列出工作台创建的章节归档，不读取正文到返回值。 */
export async function listChapterArchives(
  root: string,
): Promise<ChapterArchiveEntry[]> {
  const entries: ChapterArchiveEntry[] = [];
  for (const manifest of await archiveManifests(root)) {
    const { document } = manifest;
    if (document.asset_type !== "chapter" || !document.chapter_state) continue;
    let title = document.chapter_state.chapter_id;
    try {
      const content = await readFile(
        resolveInside(root, document.archive_path),
        "utf8",
      );
      title = analyzeChapterMarkdown(content).title || title;
    } catch {
      // 缺失归档正文由 restoreIssue 呈现，不让一个损坏条目拖垮整个列表。
    }
    entries.push({
      id: manifest.id,
      archivedAt: document.archived_at,
      volumeId: document.chapter_state.volume_id,
      chapterId: document.chapter_state.chapter_id,
      title,
      originalPath: document.original_path,
      archivePath: document.archive_path,
      reason: document.reason,
      status: document.chapter_state.status,
      restorable: document.restorable,
      restoredAt: document.restored_at,
      ...(!document.restorable && !document.restored_at
        ? { restoreIssue: "此归档已标记为不可恢复" }
        : {}),
    });
  }
  return entries.sort((left, right) =>
    right.archivedAt.localeCompare(left.archivedAt),
  );
}

/** 预览章节恢复；目标占用时绝不覆盖或自动改名。 */
export async function prepareChapterRestore(
  root: string,
  input: ChapterRestoreInput,
): Promise<ChapterMutationPreview> {
  const archive = await loadArchive(root, input.archiveId);
  const manifest = archive.document;
  assert(manifest.restorable, "ARCHIVE_NOT_RESTORABLE", "归档不可恢复", 409);
  const state = manifest.chapter_state!;
  let archivedContent: string;
  try {
    archivedContent = await readFile(
      resolveInside(root, manifest.archive_path),
      "utf8",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AppError("ARCHIVE_CONTENT_MISSING", "归档正文不存在", 409);
    }
    throw error;
  }
  assert(
    sha256(archivedContent) === manifest.before_hash,
    "ARCHIVE_HASH_MISMATCH",
    "归档正文哈希不符，拒绝恢复",
    409,
  );
  validateChapterContent(archivedContent);
  await assertRestoreTargetAvailable(root, manifest.original_path);
  const volume = await loadVolumeStatus(root, state.volume_id);
  const expectedOriginalPath = `40_正文/卷/${state.volume_id}/${volume.document.canonical_root}/${state.chapter_id}.md`;
  const expectedArchivePrefix = `${ARCHIVE_ROOT}/${input.archiveId}/`;
  assert(
    manifest.original_path === expectedOriginalPath &&
      manifest.archive_path ===
        `${expectedArchivePrefix}${expectedOriginalPath}`,
    "INVALID_ARCHIVE_MANIFEST",
    "归档清单中的章节路径与身份不一致",
    409,
  );
  const number = parseChapterId(state.chapter_id)!;
  assert(
    !volume.statuses.has(number),
    "RESTORE_STATUS_OCCUPIED",
    "状态表中已存在同章 ID，拒绝恢复",
    409,
  );
  const statuses = new Map(volume.statuses);
  statuses.set(number, {
    status: state.status,
    humanApproved: state.human_approved,
    reviewGate: state.review_gate,
    note: state.note,
  });
  const statusContent = serializeVolumeStatus(
    volume,
    statuses,
    volume.document.volume.chapter_count + 1,
  );
  const restoredAt = new Date().toISOString();
  const updatedManifest = yaml.dump(
    { ...manifest, restorable: false, restored_at: restoredAt },
    { noRefs: true, lineWidth: 120 },
  );
  const ticket = await prepareMutation(root, {
    kind: `chapter-restore:${state.volume_id}:${state.chapter_id}`,
    guards: await chapterIdentityGuards(root),
    operations: [
      {
        kind: "create",
        path: manifest.original_path,
        content: archivedContent,
      },
      { kind: "replace", path: volume.path, content: statusContent },
      { kind: "replace", path: archive.manifestPath, content: updatedManifest },
      { kind: "remove", path: manifest.archive_path },
    ],
  });
  const analysis = analyzeChapterMarkdown(archivedContent);
  return rememberPreview({
    token: ticket.token,
    kind: "restore",
    expiresAt: ticket.expiresAt,
    volumeId: state.volume_id,
    chapterId: state.chapter_id,
    targetPath: manifest.original_path,
    afterHash: manifest.before_hash,
    beforeWordCount: 0,
    afterWordCount: analysis.wordCount,
    diff: textDiff("", archivedContent),
    plannedChanges: [
      `恢复 ${manifest.original_path}`,
      `更新 ${volume.path}`,
      `更新 ${archive.manifestPath}`,
    ],
    referenceImpacts: [],
    confirmationRequirements: ["confirm-restore", "confirm-status-update"],
    destinationHref: chapterHref(state.volume_id, state.chapter_id),
    archiveId: input.archiveId,
  });
}

/** 提交已确认的章节 mutation，并刷新仓库只读索引缓存。 */
export async function commitChapterMutation(
  root: string,
  token: string,
  confirmationKeys: readonly string[],
): Promise<ChapterMutationCommitResult> {
  const pending = pendingMutations.get(token);
  pendingMutations.delete(token);
  assert(pending, "INVALID_PREVIEW_TOKEN", "章节预览令牌无效或已使用", 409);
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
  invalidateRepositoryReadModel(root);
  const result: ChapterMutationCommitResult = {
    kind: pending.kind,
    volumeId: pending.volumeId,
    chapterId: pending.chapterId,
    destinationHref: pending.destinationHref,
    archiveId: pending.archiveId,
  };
  if (pending.kind !== "archive" && pending.kind !== "delete") {
    result.chapter = await readChapterDetail(
      root,
      pending.volumeId,
      pending.chapterId,
    );
  }
  return result;
}

export function hasPendingChapterMutation(token: string): boolean {
  return pendingMutations.has(token);
}
