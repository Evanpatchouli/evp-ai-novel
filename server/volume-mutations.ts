import { randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { diffLines } from "diff";
import fg from "fast-glob";
import yaml from "js-yaml";
import type {
  TextChange,
  VolumeArchiveEntry,
  VolumeCreateDefaults,
  VolumeMutationCommitResult,
  VolumeMutationKind,
  VolumeMutationPreview,
  VolumeReferenceImpact,
} from "../shared/contracts.js";
import { volumeHref } from "../shared/reader-paths.js";
import { readDeletionHistory, recordDeletion } from "./deletion-history.js";
import { AppError, assert } from "./errors.js";
import { resolveInside } from "./files.js";
import { nodeFileOps } from "./mutations/file-ops.js";
import {
  commitMutation,
  discardMutationPreview,
  prepareMutation,
} from "./mutations/index.js";
import {
  ArchiveManifestSchema,
  VolumeArchiveManifestSchema,
  VolumeStatusDocumentSchema,
  parseVolumeStatusYaml,
  type VolumeArchiveManifest,
  type VolumeStatusDocument,
} from "./repository-domain.js";
import {
  invalidateRepositoryReadModel,
  readRepositoryIndex,
  readVolumeDetail,
} from "./repository.js";

const ARCHIVE_ROOT = "99_归档/工作台回收站";
const VOLUME_ROOT = "40_正文/卷";
const PLANNING_VOLUME_ROOT = "20_规划/卷";

interface PendingVolumeMutation {
  kind: VolumeMutationKind;
  volumeId: string;
  destinationHref: string;
  archiveId?: string;
  confirmationRequirements: string[];
}

interface VolumeCreateInput {
  title: string;
}

interface VolumeRenameInput {
  volumeId: string;
  title: string;
}

interface VolumeArchiveInput {
  volumeId: string;
  reason: string;
}

interface VolumeRestoreInput {
  archiveId: string;
}

interface LoadedVolumeStatus {
  path: string;
  content: string;
  document: VolumeStatusDocument;
}

const pendingMutations = new Map<string, PendingVolumeMutation>();

function textDiff(before: string, after: string): TextChange[] {
  return diffLines(before, after).map((part) => ({
    type: part.added ? "added" : part.removed ? "removed" : "unchanged",
    value: part.value,
    count: part.count,
  }));
}

function normalizedIdentity(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function formatVolumeId(number: number): string {
  assert(
    Number.isSafeInteger(number) && number > 0,
    "VOLUME_ID_EXHAUSTED",
    "无法生成新的卷 ID",
    409,
  );
  return `v${String(number).padStart(2, "0")}`;
}

function assertArchiveId(value: string): void {
  assert(
    /^[0-9TZ.-]+-[a-f0-9-]{36}$/i.test(value),
    "INVALID_ARCHIVE_ID",
    "归档 ID 不合法",
  );
}

function archiveId(): string {
  return `${new Date().toISOString().replace(/:/g, "-")}-${randomUUID()}`;
}

async function exists(root: string, relative: string): Promise<boolean> {
  try {
    await stat(resolveInside(root, relative));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertArchiveTreeHasNoLinks(
  root: string,
  relative: string,
): Promise<void> {
  const visit = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isSymbolicLink())
        throw new AppError(
          "UNSAFE_ARCHIVE_TREE",
          "卷归档目录树包含符号链接或 junction，拒绝移动",
          409,
          { path: path.relative(root, child).split(path.sep).join("/") },
        );
      if (entry.isDirectory()) await visit(child);
    }
  };
  await visit(resolveInside(root, relative));
}

async function assertRepositoryHealthy(root: string, action: string) {
  const index = await readRepositoryIndex(root);
  assert(
    !index.health.issues.some((issue) => issue.severity === "blocking"),
    "REPOSITORY_HEALTH_BLOCKING",
    `仓库存在阻断级健康问题，不能${action}`,
    409,
  );
  return index;
}

async function loadVolumeStatus(
  root: string,
  volumeId: string,
): Promise<LoadedVolumeStatus> {
  const relative = `${VOLUME_ROOT}/${volumeId}/状态.yaml`;
  let content: string;
  try {
    content = await readFile(resolveInside(root, relative), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new AppError("VOLUME_NOT_FOUND", "卷不存在", 404);
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
  return { path: relative, content, document: parsed.document };
}

async function readVolumeArchiveManifests(root: string) {
  const paths = await fg(`${ARCHIVE_ROOT}/*/manifest.yaml`, {
    cwd: root,
    onlyFiles: true,
  });
  const entries: Array<{
    id: string;
    path: string;
    raw: string;
    document: VolumeArchiveManifest;
  }> = [];
  for (const manifestPath of paths.sort()) {
    const raw = await readFile(resolveInside(root, manifestPath), "utf8");
    const parsed = ArchiveManifestSchema.safeParse(yaml.load(raw));
    assert(
      parsed.success,
      "INVALID_ARCHIVE_MANIFEST",
      `归档清单损坏：${manifestPath}`,
      409,
    );
    if (parsed.data.schema_version !== 2 || parsed.data.asset_type !== "volume")
      continue;
    entries.push({
      id: path.posix.basename(path.posix.dirname(manifestPath)),
      path: manifestPath,
      raw,
      document: parsed.data,
    });
  }
  return entries;
}

/** 返回下一卷身份；现存与归档历史身份均永不复用。 */
export async function getVolumeCreateDefaults(
  root: string,
): Promise<VolumeCreateDefaults> {
  const index = await assertRepositoryHealthy(root, "新建卷");
  let maximumId = 0;
  let maximumNumber = 0;
  for (const volume of index.volumes) {
    maximumId = Math.max(maximumId, Number(volume.id.slice(1)));
    maximumNumber = Math.max(maximumNumber, volume.number);
  }
  for (const { document } of await readVolumeArchiveManifests(root)) {
    maximumId = Math.max(
      maximumId,
      Number(document.volume_state.volume_id.slice(1)),
    );
    maximumNumber = Math.max(
      maximumNumber,
      document.volume_state.volume_number,
    );
  }
  for (const entry of await readDeletionHistory(root)) {
    if (entry.kind === "volume") {
      maximumId = Math.max(maximumId, Number(entry.volumeId.slice(1)));
      maximumNumber = Math.max(maximumNumber, entry.volumeNumber);
    }
  }
  const volumeId = formatVolumeId(maximumId + 1);
  const volumeNumber = maximumNumber + 1;
  return {
    volumeId,
    volumeNumber,
    targetPath: `${VOLUME_ROOT}/${volumeId}/状态.yaml`,
  };
}

function rememberPreview(
  preview: VolumeMutationPreview,
): VolumeMutationPreview {
  pendingMutations.set(preview.token, {
    kind: preview.kind,
    volumeId: preview.volumeId,
    destinationHref: preview.destinationHref,
    archiveId: preview.archiveId,
    confirmationRequirements: preview.confirmationRequirements,
  });
  return preview;
}

/** 预览创建 schema v2 空卷；不自动生成剧情或卷纲。 */
export async function prepareVolumeCreate(
  root: string,
  input: VolumeCreateInput,
): Promise<VolumeMutationPreview> {
  const title = input.title.trim();
  const defaults = await getVolumeCreateDefaults(root);
  const document = VolumeStatusDocumentSchema.parse({
    schema_version: 2,
    volume: {
      id: defaults.volumeId,
      number: defaults.volumeNumber,
      title,
      status: "planned",
      chapter_count: 0,
    },
    canonical_root: "章节",
    status_authority: "本文件",
    status_ranges: [],
  });
  const statusContent = yaml.dump(document, { noRefs: true, lineWidth: 120 });
  const volumePath = `${VOLUME_ROOT}/${defaults.volumeId}`;
  const ticket = await prepareMutation(root, {
    kind: `volume-create:${defaults.volumeId}`,
    guards: [
      { kind: "directory-snapshot", path: VOLUME_ROOT },
      { kind: "directory-snapshot", path: ARCHIVE_ROOT },
    ],
    operations: [
      {
        kind: "create-tree",
        path: volumePath,
        entries: [
          { kind: "directory", path: "章节" },
          { kind: "file", path: "状态.yaml", content: statusContent },
        ],
      },
    ],
  });
  return rememberPreview({
    token: ticket.token,
    kind: "create",
    expiresAt: ticket.expiresAt,
    volumeId: defaults.volumeId,
    volumeNumber: defaults.volumeNumber,
    targetPath: defaults.targetPath,
    diff: textDiff("", statusContent),
    plannedChanges: [
      `创建 ${volumePath}`,
      `创建 ${volumePath}/章节`,
      `创建 ${defaults.targetPath}`,
    ],
    referenceImpacts: [],
    confirmationRequirements: ["confirm-volume-create"],
    destinationHref: volumeHref(defaults.volumeId),
  });
}

/** 预览卷名修改；卷 ID、卷号及物理路径保持不变。 */
export async function prepareVolumeRename(
  root: string,
  input: VolumeRenameInput,
): Promise<VolumeMutationPreview> {
  await assertRepositoryHealthy(root, "修改卷名");
  const source = await loadVolumeStatus(root, input.volumeId);
  const title = input.title.trim();
  const next = VolumeStatusDocumentSchema.parse({
    ...source.document,
    volume: { ...source.document.volume, title },
  });
  assert(
    next.volume.title !== source.document.volume.title,
    "NO_VOLUME_CHANGES",
    "卷名没有变化",
  );
  const content = yaml.dump(next, { noRefs: true, lineWidth: 120 });
  const ticket = await prepareMutation(root, {
    kind: `volume-rename:${input.volumeId}`,
    operations: [{ kind: "replace", path: source.path, content }],
  });
  return rememberPreview({
    token: ticket.token,
    kind: "rename",
    expiresAt: ticket.expiresAt,
    volumeId: input.volumeId,
    volumeNumber: source.document.volume.number,
    targetPath: source.path,
    diff: textDiff(source.content, content),
    plannedChanges: [`更新 ${source.path} 中的卷名`],
    referenceImpacts: [],
    confirmationRequirements: ["confirm-volume-rename"],
    destinationHref: volumeHref(input.volumeId),
  });
}

function referenceKind(relative: string): VolumeReferenceImpact["kind"] {
  if (relative.startsWith("30_生产/")) return "production";
  if (relative.startsWith("50_审稿/")) return "review";
  if (relative.startsWith("60_发布/")) return "publication";
  return "planning";
}

async function findReferenceImpacts(
  root: string,
  volumeId: string,
): Promise<VolumeReferenceImpact[]> {
  const candidates = await fg(
    [
      "00_项目/**/*.{md,yaml,yml}",
      "20_规划/**/*.{md,yaml,yml}",
      "30_生产/**/*.{md,yaml,yml}",
      "50_审稿/**/*.{md,yaml,yml}",
      "60_发布/**/*.{md,yaml,yml}",
    ],
    {
      cwd: root,
      onlyFiles: true,
      ignore: [`${ARCHIVE_ROOT}/**`, `${PLANNING_VOLUME_ROOT}/${volumeId}/**`],
    },
  );
  const escaped = volumeId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const structured = new RegExp(
    `(?:volumeId|volume_id|current_volume)\\s*:\\s*[\"']?${escaped}(?:[\"']?\\s*(?:$|#))`,
    "m",
  );
  const pathReference = new RegExp(`(?:^|[\\/])${escaped}(?:[\\/]|$)`, "i");
  const impacts: VolumeReferenceImpact[] = [];
  for (const relative of candidates.sort()) {
    const content = await readFile(resolveInside(root, relative), "utf8");
    const evidence = structured.test(content)
      ? volumeId
      : pathReference.test(content)
        ? `路径片段 ${volumeId}`
        : pathReference.test(relative)
          ? `文件路径 ${volumeId}`
          : undefined;
    if (!evidence) continue;
    impacts.push({
      path: relative,
      kind: referenceKind(relative),
      severity:
        relative.startsWith("30_生产/active/") ||
        /current_volume\s*:/.test(content)
          ? "blocking"
          : "warning",
      evidence,
    });
  }
  return impacts;
}

function archiveTreePath(id: string, originalPath: string): string {
  return `${ARCHIVE_ROOT}/${id}/assets/${originalPath}`;
}

async function ownedVolumePaths(root: string, volumeId: string) {
  const paths = [`${VOLUME_ROOT}/${volumeId}`];
  const planningPath = `${PLANNING_VOLUME_ROOT}/${volumeId}`;
  if (await exists(root, planningPath)) paths.push(planningPath);
  return paths;
}

/** 预览空卷归档；正文卷与自有卷纲作为一个聚合归档单元移动。 */
export async function prepareVolumeArchive(
  root: string,
  input: VolumeArchiveInput,
): Promise<VolumeMutationPreview> {
  assert(input.reason.trim(), "ARCHIVE_REASON_REQUIRED", "必须填写归档原因");
  const index = await assertRepositoryHealthy(root, "归档卷");
  const volume = index.volumes.find((item) => item.id === input.volumeId);
  assert(volume, "VOLUME_NOT_FOUND", "卷不存在", 404);
  assert(
    volume.chapterCount === 0,
    "VOLUME_NOT_EMPTY",
    "阶段 4 只允许归档空卷，不能绕过章节归档与终稿门禁",
    409,
  );
  const source = await loadVolumeStatus(root, input.volumeId);
  const impacts = await findReferenceImpacts(root, input.volumeId);
  assert(
    !impacts.some(
      (impact) =>
        impact.severity === "blocking" && impact.kind === "production",
    ),
    "VOLUME_HAS_ACTIVE_TASK",
    "卷仍被活动生产任务引用，不能归档",
    409,
  );
  assert(
    !impacts.some((impact) => impact.severity === "blocking"),
    "VOLUME_HAS_BLOCKING_REFERENCE",
    "卷仍被当前位置等阻断引用，不能归档",
    409,
  );

  const id = archiveId();
  const ownedPaths = await ownedVolumePaths(root, input.volumeId);
  const assets: VolumeArchiveManifest["assets"] = [];
  for (const originalPath of ownedPaths) {
    await assertArchiveTreeHasNoLinks(root, originalPath);
    assets.push({
      original_path: originalPath,
      archive_path: archiveTreePath(id, originalPath),
      tree_hash: await nodeFileOps.snapshotDirectory(
        resolveInside(root, originalPath),
      ),
    });
  }
  const manifest: VolumeArchiveManifest = {
    schema_version: 2,
    archived_at: new Date().toISOString(),
    asset_type: "volume",
    reason: input.reason.trim(),
    affected_references: impacts.map((impact) => impact.path),
    restorable: true,
    volume_state: {
      volume_id: input.volumeId,
      volume_number: source.document.volume.number,
      title: source.document.volume.title,
      status: source.document.volume.status,
    },
    assets,
  };
  const manifestContent = yaml.dump(manifest, {
    noRefs: true,
    lineWidth: 120,
  });
  const envelope = `${ARCHIVE_ROOT}/${id}`;
  const directoryEntries = new Set<string>(["assets"]);
  for (const asset of assets) {
    const parentParts = path.posix
      .dirname(asset.original_path)
      .split("/")
      .filter(Boolean);
    let current = "assets";
    for (const part of parentParts) {
      current = `${current}/${part}`;
      directoryEntries.add(current);
    }
  }
  const ticket = await prepareMutation(root, {
    kind: `volume-archive:${input.volumeId}`,
    guards: [
      { kind: "directory-snapshot", path: "30_生产/active" },
      ...impacts.map((impact) => ({
        kind: "file-hash" as const,
        path: impact.path,
      })),
    ],
    operations: [
      {
        kind: "create-tree",
        path: envelope,
        entries: [
          ...[...directoryEntries].sort().map((entryPath) => ({
            kind: "directory" as const,
            path: entryPath,
          })),
          { kind: "file", path: "manifest.yaml", content: manifestContent },
        ],
      },
      ...assets.map((asset) => ({
        kind: "move-tree" as const,
        path: asset.original_path,
        destinationPath: asset.archive_path,
      })),
    ],
  });
  return rememberPreview({
    token: ticket.token,
    kind: "archive",
    expiresAt: ticket.expiresAt,
    volumeId: input.volumeId,
    volumeNumber: source.document.volume.number,
    targetPath: envelope,
    diff: textDiff(source.content, ""),
    plannedChanges: [
      ...assets.map(
        (asset) => `归档 ${asset.original_path} → ${asset.archive_path}`,
      ),
      `创建 ${envelope}/manifest.yaml`,
    ],
    referenceImpacts: impacts,
    confirmationRequirements: [
      "confirm-volume-archive",
      ...(impacts.length ? ["confirm-reference-impacts"] : []),
    ],
    destinationHref: "/chapters",
    archiveId: id,
  });
}

export async function prepareVolumeDelete(
  root: string,
  volumeId: string,
): Promise<VolumeMutationPreview> {
  const index = await assertRepositoryHealthy(root, "删除卷");
  const volume = index.volumes.find((item) => item.id === volumeId);
  assert(volume, "VOLUME_NOT_FOUND", "卷不存在", 404);
  const impacts = await findReferenceImpacts(root, volumeId);
  assert(
    !impacts.some((impact) => impact.severity === "blocking"),
    "VOLUME_HAS_BLOCKING_REFERENCE",
    "卷仍被活动任务或当前位置引用，不能删除",
    409,
  );
  const source = await loadVolumeStatus(root, volumeId);
  const paths = await ownedVolumePaths(root, volumeId);
  for (const asset of paths) await assertArchiveTreeHasNoLinks(root, asset);
  const ticket = await prepareMutation(root, {
    kind: `volume-delete:${volumeId}`,
    guards: [
      { kind: "directory-snapshot", path: "30_生产/active" },
      ...impacts.map((impact) => ({
        kind: "file-hash" as const,
        path: impact.path,
      })),
    ],
    operations: [
      ...paths.map((asset) => ({ kind: "remove-tree" as const, path: asset })),
      recordDeletion({
        kind: "volume",
        volumeId,
        volumeNumber: volume.number,
        lastChapterNumber: volume.chapters.reduce(
          (maximum, chapter) => Math.max(maximum, chapter.number),
          0,
        ),
      }),
    ],
  });
  return rememberPreview({
    token: ticket.token,
    kind: "delete",
    expiresAt: ticket.expiresAt,
    volumeId,
    volumeNumber: source.document.volume.number,
    targetPath: paths[0]!,
    diff: textDiff(source.content, ""),
    plannedChanges: [
      `删除本卷的 ${volume.chapterCount} 章正文`,
      ...paths.map((asset) => `删除 ${asset}`),
      "记录已删除的卷号与章号",
    ],
    referenceImpacts: impacts,
    confirmationRequirements: [
      "confirm-volume-delete",
      ...(volume.finalCount ? ["confirm-final-delete"] : []),
      ...(impacts.length ? ["confirm-reference-impacts"] : []),
    ],
    destinationHref: "/chapters",
  });
}

async function loadVolumeArchive(root: string, id: string) {
  assertArchiveId(id);
  const manifestPath = `${ARCHIVE_ROOT}/${id}/manifest.yaml`;
  let raw: string;
  try {
    raw = await readFile(resolveInside(root, manifestPath), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new AppError("ARCHIVE_NOT_FOUND", "卷归档不存在", 404);
    throw error;
  }
  const parsed = VolumeArchiveManifestSchema.safeParse(yaml.load(raw));
  assert(
    parsed.success,
    "INVALID_ARCHIVE_MANIFEST",
    "卷归档清单损坏或缺少恢复元数据",
    409,
  );
  return { manifestPath, raw, document: parsed.data };
}

async function assertRestoreTargetsAvailable(
  root: string,
  assets: VolumeArchiveManifest["assets"],
) {
  for (const asset of assets) {
    const parent = path.posix.dirname(asset.original_path);
    const base = path.posix.basename(asset.original_path);
    if (!(await exists(root, parent))) continue;
    const names = await readdir(resolveInside(root, parent));
    if (
      names.some(
        (name) => normalizedIdentity(name) === normalizedIdentity(base),
      )
    )
      throw new AppError(
        "RESTORE_TARGET_OCCUPIED",
        "恢复目标路径已被占用，拒绝覆盖",
        409,
        { path: asset.original_path },
      );
  }
}

/** 列出工作台创建的卷归档，不读取归档正文内容。 */
export async function listVolumeArchives(
  root: string,
): Promise<VolumeArchiveEntry[]> {
  const entries = await readVolumeArchiveManifests(root);
  return entries
    .map(({ id, document }) => ({
      id,
      archivedAt: document.archived_at,
      volumeId: document.volume_state.volume_id,
      volumeNumber: document.volume_state.volume_number,
      title: document.volume_state.title,
      originalPath: `${VOLUME_ROOT}/${document.volume_state.volume_id}`,
      reason: document.reason,
      restorable: document.restorable,
      restoredAt: document.restored_at,
      ...(!document.restorable && !document.restored_at
        ? { restoreIssue: "此归档已标记为不可恢复" }
        : {}),
    }))
    .sort((left, right) => right.archivedAt.localeCompare(left.archivedAt));
}

/** 预览卷恢复；所有原路径、树哈希和卷身份均必须保持一致。 */
export async function prepareVolumeRestore(
  root: string,
  input: VolumeRestoreInput,
): Promise<VolumeMutationPreview> {
  const archive = await loadVolumeArchive(root, input.archiveId);
  const manifest = archive.document;
  assert(manifest.restorable, "ARCHIVE_NOT_RESTORABLE", "卷归档不可恢复", 409);
  await assertRestoreTargetsAvailable(root, manifest.assets);
  const index = await assertRepositoryHealthy(root, "恢复卷");
  assert(
    !index.volumes.some(
      (volume) =>
        volume.id === manifest.volume_state.volume_id ||
        volume.number === manifest.volume_state.volume_number,
    ),
    "RESTORE_VOLUME_IDENTITY_OCCUPIED",
    "卷 ID 或卷号已被占用，拒绝恢复",
    409,
  );
  const envelopePrefix = `${ARCHIVE_ROOT}/${input.archiveId}/assets/`;
  for (const asset of manifest.assets) {
    assert(
      asset.archive_path === `${envelopePrefix}${asset.original_path}`,
      "INVALID_ARCHIVE_MANIFEST",
      "卷归档路径与原始身份不一致",
      409,
    );
    await assertArchiveTreeHasNoLinks(root, asset.archive_path);
    const currentHash = await nodeFileOps.snapshotDirectory(
      resolveInside(root, asset.archive_path),
    );
    assert(
      currentHash === asset.tree_hash,
      "ARCHIVE_HASH_MISMATCH",
      "卷归档目录树哈希不符，拒绝恢复",
      409,
    );
  }
  const restoredAt = new Date().toISOString();
  const updatedManifest = yaml.dump(
    { ...manifest, restorable: false, restored_at: restoredAt },
    { noRefs: true, lineWidth: 120 },
  );
  const ticket = await prepareMutation(root, {
    kind: `volume-restore:${manifest.volume_state.volume_id}`,
    guards: [
      { kind: "directory-snapshot", path: VOLUME_ROOT },
      { kind: "directory-snapshot", path: ARCHIVE_ROOT },
    ],
    operations: [
      ...manifest.assets.map((asset) => ({
        kind: "move-tree" as const,
        path: asset.archive_path,
        destinationPath: asset.original_path,
      })),
      {
        kind: "replace" as const,
        path: archive.manifestPath,
        content: updatedManifest,
      },
    ],
  });
  return rememberPreview({
    token: ticket.token,
    kind: "restore",
    expiresAt: ticket.expiresAt,
    volumeId: manifest.volume_state.volume_id,
    volumeNumber: manifest.volume_state.volume_number,
    targetPath: `${VOLUME_ROOT}/${manifest.volume_state.volume_id}`,
    diff: textDiff(archive.raw, updatedManifest),
    plannedChanges: [
      ...manifest.assets.map(
        (asset) => `恢复 ${asset.archive_path} → ${asset.original_path}`,
      ),
      `更新 ${archive.manifestPath}`,
    ],
    referenceImpacts: [],
    confirmationRequirements: ["confirm-volume-restore"],
    destinationHref: volumeHref(manifest.volume_state.volume_id),
    archiveId: input.archiveId,
  });
}

export function hasPendingVolumeMutation(token: string): boolean {
  return pendingMutations.has(token);
}

/** 提交卷 mutation；确认失败同样消费领域预览，底层 token 不可重放。 */
export async function commitVolumeMutation(
  root: string,
  token: string,
  confirmationKeys: readonly string[],
): Promise<VolumeMutationCommitResult> {
  const pending = pendingMutations.get(token);
  pendingMutations.delete(token);
  assert(pending, "INVALID_PREVIEW_TOKEN", "卷预览令牌无效或已使用", 409);
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
  const result: VolumeMutationCommitResult = {
    kind: pending.kind,
    volumeId: pending.volumeId,
    destinationHref: pending.destinationHref,
    archiveId: pending.archiveId,
  };
  if (pending.kind !== "archive" && pending.kind !== "delete")
    result.volume = await readVolumeDetail(root, pending.volumeId);
  return result;
}
