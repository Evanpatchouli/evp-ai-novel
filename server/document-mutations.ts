import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { diffLines } from "diff";
import fg from "fast-glob";
import yaml from "js-yaml";
import type {
  DocumentArchiveEntry,
  DocumentMutationCommitResult,
  DocumentMutationKind,
  DocumentMutationPreview,
  DocumentReferenceImpact,
  TextChange,
} from "../shared/contracts.js";
import { AppError, assert } from "./errors.js";
import { resolveInside, sha256 } from "./files.js";
import {
  commitMutation,
  discardMutationPreview,
  prepareMutation,
} from "./mutations/index.js";
import {
  ArchiveManifestSchema,
  DocumentArchiveManifestSchema,
  DocumentPathSchema,
  documentPolicy,
  type DocumentArchiveManifest,
} from "./repository-domain.js";
import { authorityFor, readDocument } from "./repository.js";

const ARCHIVE_ROOT = "99_归档/工作台回收站";
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

interface PendingDocumentMutation {
  kind: DocumentMutationKind;
  targetPath: string;
  destinationHref: string;
  archiveId?: string;
  confirmationRequirements: string[];
}

const pendingMutations = new Map<string, PendingDocumentMutation>();

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

function archiveId(): string {
  return `${new Date().toISOString().replace(/:/g, "-")}-${randomUUID()}`;
}

function assertArchiveId(value: string): void {
  assert(
    /^[0-9TZ.-]+-[a-f0-9-]{36}$/i.test(value),
    "INVALID_ARCHIVE_ID",
    "归档 ID 不合法",
  );
}

function assertContentSize(content: string): void {
  assert(
    Buffer.byteLength(content, "utf8") <= MAX_DOCUMENT_BYTES,
    "DOCUMENT_TOO_LARGE",
    "Markdown 文档不能超过 2 MiB",
  );
}

function assertWritablePath(relative: string): void {
  const parsed = DocumentPathSchema.safeParse(relative);
  assert(parsed.success, "INVALID_DOCUMENT_PATH", "文档路径不合法");
  const policy = documentPolicy(relative);
  assert(
    policy?.capabilities.editable,
    "DOCUMENT_AUTHORITY_NOT_ALLOWED",
    "此权威目录不允许普通文档写入",
    403,
  );
}

async function assertNoLinks(root: string, relative: string): Promise<void> {
  const parts = relative.split("/");
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const metadata = await lstat(current).catch(() => null);
    if (!metadata) break;
    if (metadata.isSymbolicLink())
      throw new AppError(
        "UNSAFE_DOCUMENT_PATH",
        "文档路径不能经过符号链接或 junction",
        409,
        { path: relative },
      );
  }
}

async function assertParentDirectory(root: string, relative: string) {
  const parent = path.posix.dirname(relative);
  await assertNoLinks(root, parent);
  const metadata = await stat(resolveInside(root, parent)).catch(() => null);
  assert(
    metadata?.isDirectory(),
    "DOCUMENT_PARENT_NOT_FOUND",
    "文档父目录不存在",
    409,
  );
  return parent;
}

async function assertNormalizedTargetAbsent(
  root: string,
  relative: string,
  occupiedCode = "DOCUMENT_TARGET_OCCUPIED",
) {
  const parent = await assertParentDirectory(root, relative);
  const base = path.posix.basename(relative);
  const names = await readdir(resolveInside(root, parent));
  if (
    names.some((name) => normalizedIdentity(name) === normalizedIdentity(base))
  )
    throw new AppError(
      occupiedCode,
      "目标路径已存在大小写或 Unicode 规范化冲突",
      409,
      { path: relative },
    );
  return parent;
}

async function findReferenceImpacts(
  root: string,
  sourcePath: string,
): Promise<DocumentReferenceImpact[]> {
  const candidates = await fg(
    [
      "{00_项目,10_圣经,20_规划,30_生产,40_正文,50_审稿,60_发布,70_素材}/**/*.{md,yaml,yml}",
    ],
    { cwd: root, onlyFiles: true, followSymbolicLinks: false },
  );
  const base = path.posix.basename(sourcePath);
  const impacts: DocumentReferenceImpact[] = [];
  for (const candidate of candidates.sort()) {
    if (candidate === sourcePath) continue;
    const content = await readFile(
      resolveInside(root, candidate),
      "utf8",
    ).catch(() => "");
    if (!content) continue;
    const direct = content.includes(sourcePath);
    const suspected = !direct && base.length >= 4 && content.includes(base);
    if (!direct && !suspected) continue;
    const task = candidate.startsWith("30_生产/active/");
    impacts.push({
      path: candidate,
      kind: task ? "task" : direct ? "markdown-link" : "suspected-text",
      severity: task ? "blocking" : "warning",
      evidence: direct ? sourcePath : base,
    });
  }
  return impacts;
}

function remember(preview: DocumentMutationPreview): DocumentMutationPreview {
  pendingMutations.set(preview.token, {
    kind: preview.kind,
    targetPath: preview.targetPath,
    destinationHref: preview.destinationHref,
    archiveId: preview.archiveId,
    confirmationRequirements: preview.confirmationRequirements,
  });
  return preview;
}

/** 预览在已有受支持目录中新建 Markdown。 */
export async function prepareDocumentCreate(
  root: string,
  input: { path: string; content: string },
): Promise<DocumentMutationPreview> {
  assertWritablePath(input.path);
  assertContentSize(input.content);
  const parent = await assertNormalizedTargetAbsent(root, input.path);
  const ticket = await prepareMutation(root, {
    kind: `document-create:${input.path}`,
    guards: [{ kind: "directory-snapshot", path: parent }],
    operations: [{ kind: "create", path: input.path, content: input.content }],
  });
  return remember({
    token: ticket.token,
    kind: "create",
    expiresAt: ticket.expiresAt,
    targetPath: input.path,
    diff: textDiff("", input.content),
    plannedChanges: [`创建 ${input.path}`],
    referenceImpacts: [],
    confirmationRequirements: ["confirm-document-create"],
    destinationHref: `/documents/view?path=${encodeURIComponent(input.path)}`,
  });
}

/** 预览带旧哈希校验的 Markdown 修改。 */
export async function prepareDocumentEdit(
  root: string,
  input: { path: string; content: string; expectedHash: string },
): Promise<DocumentMutationPreview> {
  assertWritablePath(input.path);
  assertContentSize(input.content);
  await assertNoLinks(root, input.path);
  const source = await readDocument(root, input.path);
  assert(
    source.sourceHash === input.expectedHash,
    "DOCUMENT_CONFLICT",
    "文档已被外部修改",
    409,
  );
  assert(
    source.content !== input.content,
    "NO_DOCUMENT_CHANGES",
    "文档内容没有变化",
  );
  const ticket = await prepareMutation(root, {
    kind: `document-edit:${input.path}`,
    operations: [{ kind: "replace", path: input.path, content: input.content }],
  });
  return remember({
    token: ticket.token,
    kind: "edit",
    expiresAt: ticket.expiresAt,
    targetPath: input.path,
    diff: textDiff(source.content, input.content),
    plannedChanges: [`更新 ${input.path}`],
    referenceImpacts: [],
    confirmationRequirements: ["confirm-document-edit"],
    destinationHref: `/documents/view?path=${encodeURIComponent(input.path)}`,
  });
}

/** 预览 Markdown 可恢复归档；活动任务引用会阻断归档。 */
export async function prepareDocumentArchive(
  root: string,
  input: { path: string; reason: string; expectedHash: string },
): Promise<DocumentMutationPreview> {
  assertWritablePath(input.path);
  assert(input.reason.trim(), "ARCHIVE_REASON_REQUIRED", "必须填写归档原因");
  await assertNoLinks(root, input.path);
  const source = await readDocument(root, input.path);
  assert(
    source.sourceHash === input.expectedHash,
    "DOCUMENT_CONFLICT",
    "文档已被外部修改",
    409,
  );
  const impacts = await findReferenceImpacts(root, input.path);
  assert(
    !impacts.some((impact) => impact.severity === "blocking"),
    "DOCUMENT_HAS_ACTIVE_TASK_REFERENCE",
    "文档仍被活动生产任务引用，不能归档",
    409,
  );
  const id = archiveId();
  const envelope = `${ARCHIVE_ROOT}/${id}`;
  const archivePath = `${envelope}/assets/${input.path}`;
  const manifest: DocumentArchiveManifest = {
    schema_version: 3,
    archived_at: new Date().toISOString(),
    asset_type: "document",
    original_path: input.path,
    archive_path: archivePath,
    reason: input.reason.trim(),
    before_hash: source.sourceHash,
    authority: source.authority as DocumentArchiveManifest["authority"],
    affected_references: impacts.map((impact) => impact.path),
    restorable: true,
  };
  const manifestContent = yaml.dump(manifest, { noRefs: true, lineWidth: 120 });
  const directories = new Set<string>(["assets"]);
  let current = "assets";
  for (const part of path.posix.dirname(input.path).split("/")) {
    current = `${current}/${part}`;
    directories.add(current);
  }
  const ticket = await prepareMutation(root, {
    kind: `document-archive:${input.path}`,
    guards: [
      { kind: "directory-snapshot", path: path.posix.dirname(input.path) },
      { kind: "directory-snapshot", path: ARCHIVE_ROOT },
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
          ...[...directories].sort().map((entryPath) => ({
            kind: "directory" as const,
            path: entryPath,
          })),
          { kind: "file", path: "manifest.yaml", content: manifestContent },
          {
            kind: "file",
            path: `assets/${input.path}`,
            content: source.content,
          },
        ],
      },
      { kind: "remove", path: input.path },
    ],
  });
  return remember({
    token: ticket.token,
    kind: "archive",
    expiresAt: ticket.expiresAt,
    targetPath: archivePath,
    diff: textDiff(source.content, ""),
    plannedChanges: [
      `归档 ${input.path} → ${archivePath}`,
      `创建 ${envelope}/manifest.yaml`,
    ],
    referenceImpacts: impacts,
    confirmationRequirements: [
      "confirm-document-archive",
      ...(impacts.length ? ["confirm-reference-impacts"] : []),
    ],
    destinationHref: "/documents",
    archiveId: id,
  });
}

async function readDocumentArchives(root: string) {
  const paths = await fg(`${ARCHIVE_ROOT}/*/manifest.yaml`, {
    cwd: root,
    onlyFiles: true,
    followSymbolicLinks: false,
  });
  const entries: Array<{
    id: string;
    path: string;
    raw: string;
    document: DocumentArchiveManifest;
  }> = [];
  for (const manifestPath of paths.sort()) {
    const raw = await readFile(resolveInside(root, manifestPath), "utf8");
    let value: unknown;
    try {
      value = yaml.load(raw);
    } catch {
      continue;
    }
    if (
      !value ||
      typeof value !== "object" ||
      (value as { schema_version?: unknown }).schema_version !== 3
    )
      continue;
    const parsed = ArchiveManifestSchema.safeParse(value);
    assert(
      parsed.success && parsed.data.asset_type === "document",
      "INVALID_ARCHIVE_MANIFEST",
      `文档归档清单损坏：${manifestPath}`,
      409,
    );
    entries.push({
      id: path.posix.basename(path.posix.dirname(manifestPath)),
      path: manifestPath,
      raw,
      document: parsed.data as DocumentArchiveManifest,
    });
  }
  return entries;
}

/** 列出工作台生成的文档归档。 */
export async function listDocumentArchives(
  root: string,
): Promise<DocumentArchiveEntry[]> {
  return (await readDocumentArchives(root))
    .map(({ id, document }) => ({
      id,
      archivedAt: document.archived_at,
      title: path.posix.basename(document.original_path, ".md"),
      originalPath: document.original_path,
      archivePath: document.archive_path,
      authority: document.authority,
      reason: document.reason,
      restorable: document.restorable,
      restoredAt: document.restored_at,
      ...(!document.restorable && !document.restored_at
        ? { restoreIssue: "此归档已标记为不可恢复" }
        : {}),
    }))
    .sort((left, right) => right.archivedAt.localeCompare(left.archivedAt));
}

/** 预览文档恢复，并严格保持原始路径和内容身份。 */
export async function prepareDocumentRestore(
  root: string,
  input: { archiveId: string },
): Promise<DocumentMutationPreview> {
  assertArchiveId(input.archiveId);
  const archive = (await readDocumentArchives(root)).find(
    (entry) => entry.id === input.archiveId,
  );
  assert(archive, "ARCHIVE_NOT_FOUND", "文档归档不存在", 404);
  const manifest = archive.document;
  assert(
    manifest.restorable,
    "ARCHIVE_NOT_RESTORABLE",
    "文档归档不可恢复",
    409,
  );
  assertWritablePath(manifest.original_path);
  const expectedArchivePath = `${ARCHIVE_ROOT}/${input.archiveId}/assets/${manifest.original_path}`;
  assert(
    manifest.archive_path === expectedArchivePath,
    "INVALID_ARCHIVE_MANIFEST",
    "文档归档路径与原始身份不一致",
    409,
  );
  await assertNoLinks(root, manifest.archive_path);
  const content = await readFile(
    resolveInside(root, manifest.archive_path),
    "utf8",
  ).catch(() => null);
  assert(content !== null, "ARCHIVE_CONTENT_MISSING", "文档归档正文缺失", 409);
  assert(
    sha256(content) === manifest.before_hash,
    "ARCHIVE_HASH_MISMATCH",
    "文档归档内容哈希不符",
    409,
  );
  assert(
    authorityFor(manifest.original_path) === manifest.authority,
    "INVALID_ARCHIVE_MANIFEST",
    "文档归档权威身份不一致",
    409,
  );
  const parent = await assertNormalizedTargetAbsent(
    root,
    manifest.original_path,
    "RESTORE_TARGET_OCCUPIED",
  );
  const restoredAt = new Date().toISOString();
  const updatedManifest = yaml.dump(
    { ...manifest, restorable: false, restored_at: restoredAt },
    { noRefs: true, lineWidth: 120 },
  );
  const ticket = await prepareMutation(root, {
    kind: `document-restore:${manifest.original_path}`,
    guards: [
      { kind: "directory-snapshot", path: parent },
      { kind: "directory-snapshot", path: ARCHIVE_ROOT },
    ],
    operations: [
      { kind: "create", path: manifest.original_path, content },
      { kind: "replace", path: archive.path, content: updatedManifest },
      { kind: "remove", path: manifest.archive_path },
    ],
  });
  return remember({
    token: ticket.token,
    kind: "restore",
    expiresAt: ticket.expiresAt,
    targetPath: manifest.original_path,
    diff: textDiff("", content),
    plannedChanges: [
      `恢复 ${manifest.archive_path} → ${manifest.original_path}`,
      `更新 ${archive.path}`,
    ],
    referenceImpacts: [],
    confirmationRequirements: ["confirm-document-restore"],
    destinationHref: `/documents/view?path=${encodeURIComponent(manifest.original_path)}`,
    archiveId: input.archiveId,
  });
}

export function hasPendingDocumentMutation(token: string): boolean {
  return pendingMutations.has(token);
}

/** 提交已确认的文档 mutation。 */
export async function commitDocumentMutation(
  root: string,
  token: string,
  confirmationKeys: readonly string[],
): Promise<DocumentMutationCommitResult> {
  const pending = pendingMutations.get(token);
  pendingMutations.delete(token);
  assert(pending, "INVALID_PREVIEW_TOKEN", "文档预览令牌无效或已使用", 409);
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
    destinationHref: pending.destinationHref,
    archiveId: pending.archiveId,
    ...(pending.kind === "archive"
      ? {}
      : { document: await readDocument(root, pending.targetPath) }),
  };
}
