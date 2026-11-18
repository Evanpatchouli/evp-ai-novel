import { access, lstat, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type {
  ChapterDetail,
  ChapterLink,
  ChapterSummary,
  ContextCandidate,
  DashboardData,
  DocumentDetail,
  DocumentTreeNode,
  RepositoryHealth,
  RepositoryHealthIssue,
  VolumeDetail,
  VolumeRelatedRecord,
  VolumeSummary,
} from "../shared/contracts.js";
import {
  analyzeChapterMarkdown,
  countChapterWords,
} from "../shared/chapter-text.js";
import { AppError, assert } from "./errors.js";
import { getGitStatus } from "./git.js";
import { readUtf8, relativeSlash, resolveInside, sha256 } from "./files.js";
import {
  expandStatusRanges,
  DocumentPathSchema,
  documentPolicy,
  formatChapterId,
  parseChapterId,
  parseVolumeStatusYaml,
  type ChapterStatusMetadata,
} from "./repository-domain.js";

interface CachedChapterText {
  signature: string;
  hash: string;
  title: string;
  wordCount: number;
  h1Valid: boolean;
  modifiedAt: string;
}

export interface RepositoryIndex {
  volumes: VolumeSummary[];
  health: RepositoryHealth;
}

const chapterSummaryCache = new Map<string, CachedChapterText>();

async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  transform: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await transform(items[index]!, index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () =>
      worker(),
    ),
  );
  return results;
}

async function readCachedChapterSummary(
  absolute: string,
): Promise<CachedChapterText> {
  const metadata = await stat(absolute, { bigint: true });
  const signature = `${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}`;
  const cached = chapterSummaryCache.get(absolute);
  if (cached?.signature === signature) return cached;
  const markdown = await readUtf8(absolute);
  const hash = sha256(markdown);
  if (cached?.hash === hash) {
    const unchanged = {
      ...cached,
      signature,
      modifiedAt: new Date(Number(metadata.mtimeNs / 1_000_000n)).toISOString(),
    };
    chapterSummaryCache.set(absolute, unchanged);
    return unchanged;
  }
  const heading = analyzeChapterMarkdown(markdown);
  const next = {
    signature,
    hash,
    title: heading.title,
    wordCount: countChapterWords(markdown),
    h1Valid: heading.valid,
    modifiedAt: new Date(Number(metadata.mtimeNs / 1_000_000n)).toISOString(),
  };
  chapterSummaryCache.set(absolute, next);
  return next;
}

/** 清空全部或指定仓库的只读摘要缓存。 */
export function invalidateRepositoryReadModel(root?: string): void {
  if (!root) {
    chapterSummaryCache.clear();
    return;
  }
  const prefix = `${path.resolve(root)}${path.sep}`;
  for (const key of chapterSummaryCache.keys()) {
    if (key.startsWith(prefix)) chapterSummaryCache.delete(key);
  }
}

/** 验证目录符合小说分层仓库的最低要求。 */
export async function validateRepository(rootInput: string): Promise<string> {
  const root = path.resolve(rootInput);
  const required = ["10_圣经", "20_规划", "30_生产", "40_正文", "50_审稿"];
  const missing: string[] = [];
  for (const item of required) {
    try {
      if (!(await stat(path.join(root, item))).isDirectory())
        missing.push(item);
    } catch {
      missing.push(item);
    }
  }
  assert(
    missing.length === 0,
    "INVALID_REPOSITORY",
    "所选目录不是有效的小说工程仓库",
    400,
  );
  return root;
}

/** 构建卷章摘要与健康报告；损坏卷会被诊断而不会拖垮其他健康卷。 */
export async function readRepositoryIndex(
  root: string,
): Promise<RepositoryIndex> {
  const statusPaths = await fg("40_正文/卷/*/状态.yaml", {
    cwd: root,
    onlyFiles: true,
    followSymbolicLinks: false,
  });
  const volumeDirectories = await fg("40_正文/卷/*", {
    cwd: root,
    onlyDirectories: true,
    followSymbolicLinks: false,
  });
  const issues: RepositoryHealthIssue[] = [];
  const volumes: VolumeSummary[] = [];
  const volumeIds = new Set<string>();
  const volumeNumbers = new Set<number>();
  const chapterOwners = new Map<string, string>();
  const statusDirectories = new Set(
    statusPaths.map((statusPath) => path.posix.dirname(statusPath)),
  );
  for (const volumeDirectory of volumeDirectories.sort()) {
    if (statusDirectories.has(volumeDirectory)) continue;
    issues.push({
      code: "ORPHAN_VOLUME_DIRECTORY",
      severity: "blocking",
      message: "卷目录缺少状态.yaml，不能作为健康卷读取",
      path: volumeDirectory,
      volumeId: path.posix.basename(volumeDirectory),
    });
  }

  for (const statusRelative of statusPaths.sort()) {
    const parsed = parseVolumeStatusYaml(
      await readUtf8(resolveInside(root, statusRelative)),
      statusRelative,
    );
    issues.push(...parsed.issues);
    const status = parsed.document;
    if (!status) continue;
    const volumeId = status.volume.id;
    if (volumeIds.has(volumeId)) {
      issues.push({
        code: "DUPLICATE_VOLUME_ID",
        severity: "blocking",
        message: `卷 ID 在全书中重复：${volumeId}`,
        path: statusRelative,
        volumeId,
      });
      continue;
    }
    volumeIds.add(volumeId);
    if (volumeNumbers.has(status.volume.number)) {
      issues.push({
        code: "DUPLICATE_VOLUME_NUMBER",
        severity: "blocking",
        message: `卷号在全书中重复：${status.volume.number}`,
        path: statusRelative,
        volumeId,
      });
    }
    volumeNumbers.add(status.volume.number);
    const volumeDirectory = path.posix.dirname(statusRelative);
    const expectedDirectory = volumeId;
    if (path.posix.basename(volumeDirectory) !== expectedDirectory) {
      issues.push({
        code: "VOLUME_DIRECTORY_MISMATCH",
        severity: "blocking",
        message: `卷目录应为 ${expectedDirectory}`,
        path: volumeDirectory,
        volumeId,
      });
    }
    const canonicalRoot = status.canonical_root;
    const canonicalRootPath = `${volumeDirectory}/${canonicalRoot}`;
    let canonicalRootHealthy = false;
    let canonicalRootAbsolute: string | undefined;
    let canonicalRootErrorReported = false;
    try {
      canonicalRootAbsolute = resolveInside(root, canonicalRootPath);
      canonicalRootHealthy = (await stat(canonicalRootAbsolute)).isDirectory();
    } catch (error) {
      canonicalRootErrorReported = true;
      issues.push({
        code: "INVALID_CANONICAL_ROOT",
        severity: "blocking",
        message: "卷的章节根目录缺失、类型错误或指向仓库外",
        path: canonicalRootPath,
        volumeId,
        details: error instanceof Error ? error.message : String(error),
      });
    }
    if (!canonicalRootHealthy && !canonicalRootErrorReported) {
      issues.push({
        code: "INVALID_CANONICAL_ROOT",
        severity: "blocking",
        message: "卷的章节根路径不是目录",
        path: canonicalRootPath,
        volumeId,
      });
    }
    const chapterPaths = canonicalRootHealthy
      ? await fg(`${volumeDirectory}/${canonicalRoot}/ch*.md`, {
          cwd: root,
          onlyFiles: true,
          followSymbolicLinks: false,
        })
      : [];
    const expanded = expandStatusRanges(
      status.status_ranges,
      statusRelative,
      volumeId,
    );
    issues.push(...expanded.issues);
    const activeNumbers = new Set<number>();
    const chapters: ChapterSummary[] = [];
    const chapterFiles: Array<{
      id: string;
      number: number;
      path: string;
    }> = [];
    for (const chapterRelative of chapterPaths.sort()) {
      const id = path.posix.basename(chapterRelative, ".md");
      const number = parseChapterId(id);
      if (number === null) {
        issues.push({
          code: "INVALID_CHAPTER_ID",
          severity: "blocking",
          message: `章节文件名不是规范章 ID：${id}`,
          path: chapterRelative,
          volumeId,
          chapterId: id,
        });
        continue;
      }
      chapterFiles.push({ id, number, path: chapterRelative });
    }
    chapterFiles.sort(
      (left, right) =>
        left.number - right.number || left.id.localeCompare(right.id, "en"),
    );
    const summaries = await mapConcurrent(chapterFiles, 32, async (chapter) =>
      // canonicalRoot 已在本轮读取中完成 realpath 边界校验，且 fast-glob 禁止
      // 跟随符号链接；直接拼接扫描所得的直属文件可避免为 500 章重复
      // 执行仓库根和文件 realpath，同时不放宽 junction/symlink 门禁。
      readCachedChapterSummary(
        path.join(canonicalRootAbsolute!, path.posix.basename(chapter.path)),
      ),
    );
    for (const [index, chapterFile] of chapterFiles.entries()) {
      const { id, number, path: chapterRelative } = chapterFile;
      const cached = summaries[index]!;
      activeNumbers.add(number);
      const previousOwner = chapterOwners.get(id);
      if (previousOwner) {
        issues.push({
          code: "DUPLICATE_CHAPTER_ID",
          severity: "blocking",
          message: `章 ID 在全书中重复：${id}`,
          path: chapterRelative,
          volumeId,
          chapterId: id,
          details: { previousOwner },
        });
      } else {
        chapterOwners.set(id, volumeId);
      }
      if (!cached.h1Valid) {
        issues.push({
          code: "INVALID_CHAPTER_H1",
          severity: "blocking",
          message: "章节必须以唯一、非空的 Markdown H1 开头",
          path: chapterRelative,
          volumeId,
          chapterId: id,
        });
      }
      const current: ChapterStatusMetadata | undefined =
        expanded.statuses.get(number);
      if (!current) {
        issues.push({
          code: "UNCOVERED_CHAPTER",
          severity: "blocking",
          message: `${id} 没有状态范围覆盖`,
          path: statusRelative,
          volumeId,
          chapterId: id,
        });
      }
      const count = cached.wordCount;
      chapters.push({
        id,
        number,
        title: cached.title || id,
        path: chapterRelative,
        status: current?.status ?? "unknown",
        humanApproved: current?.humanApproved ?? false,
        reviewGate: current?.reviewGate,
        wordCount: count,
        lengthFlag: count < 1200 ? "short" : count > 6000 ? "long" : "normal",
        modifiedAt: cached.modifiedAt,
      });
    }
    for (const number of expanded.statuses.keys()) {
      if (!activeNumbers.has(number)) {
        issues.push({
          code: "ORPHAN_STATUS_ENTRY",
          severity: "blocking",
          message: `${formatChapterId(number)} 有状态但没有当前正文文件`,
          path: statusRelative,
          volumeId,
          chapterId: formatChapterId(number),
        });
      }
    }
    if (status.volume.chapter_count !== chapters.length) {
      issues.push({
        code: "CHAPTER_COUNT_MISMATCH",
        severity: "blocking",
        message: `状态表记录 ${status.volume.chapter_count} 章，实际读取 ${chapters.length} 章`,
        path: statusRelative,
        volumeId,
      });
    }
    volumes.push({
      id: volumeId,
      number: status.volume.number,
      title: status.volume.title,
      lifecycleStatus: status.volume.status,
      chapterCount: chapters.length,
      finalCount: chapters.filter((chapter) => chapter.status === "final")
        .length,
      aiRevisedCount: chapters.filter(
        (chapter) => chapter.status === "ai-revised",
      ).length,
      inProgressCount: chapters.filter(
        (chapter) => !["final", "ai-revised"].includes(chapter.status),
      ).length,
      chapters,
    });
  }
  const planningVolumeDirectories = await fg("20_规划/卷/*", {
    cwd: root,
    onlyDirectories: true,
    followSymbolicLinks: false,
  });
  for (const planningDirectory of planningVolumeDirectories.sort()) {
    const volumeId = path.posix.basename(planningDirectory);
    if (volumeIds.has(volumeId)) continue;
    issues.push({
      code: "ORPHAN_PLANNING_VOLUME_DIRECTORY",
      severity: "blocking",
      message: "规划卷目录没有对应的当前正文卷",
      path: planningDirectory,
      volumeId,
    });
  }
  return {
    volumes: volumes.sort(
      (left, right) =>
        left.number - right.number || left.id.localeCompare(right.id, "en"),
    ),
    health: {
      healthy: !issues.some((issue) => issue.severity === "blocking"),
      issues,
    },
  };
}

/** 兼容现有调用方，返回不含正文的卷章摘要。 */
export async function readVolumes(root: string): Promise<VolumeSummary[]> {
  return (await readRepositoryIndex(root)).volumes;
}

function chapterLink(
  volume: VolumeSummary,
  chapter: ChapterSummary,
): ChapterLink {
  return {
    volumeId: volume.id,
    volumeNumber: volume.number,
    chapterId: chapter.id,
    chapterNumber: chapter.number,
    title: chapter.title,
  };
}

async function readVolumeStatusSource(
  root: string,
  volumeId: string,
): Promise<{
  path: string;
  historicalReviewRecords: string[];
} | null> {
  const statusPaths = await fg("40_正文/卷/*/状态.yaml", {
    cwd: root,
    onlyFiles: true,
  });
  for (const statusPath of statusPaths.sort()) {
    const parsed = parseVolumeStatusYaml(
      await readUtf8(resolveInside(root, statusPath)),
      statusPath,
    );
    if (parsed.document?.volume.id === volumeId) {
      return {
        path: statusPath,
        historicalReviewRecords:
          parsed.document.historical_review_records ?? [],
      };
    }
  }
  return null;
}

function relatedRecordKind(
  relativePath: string,
): VolumeRelatedRecord["kind"] | null {
  if (relativePath.startsWith("50_审稿/")) return "review";
  if (relativePath.startsWith("30_生产/")) return "production";
  if (relativePath.startsWith("60_发布/")) return "publication";
  return null;
}

async function resolveRelatedRecords(
  root: string,
  statusPath: string,
  references: readonly string[],
): Promise<{
  records: VolumeRelatedRecord[];
  issues: RepositoryHealthIssue[];
}> {
  const records: VolumeRelatedRecord[] = [];
  const issues: RepositoryHealthIssue[] = [];
  const seen = new Set<string>();
  for (const reference of references) {
    let relativePath: string;
    try {
      const absolute = path.resolve(root, path.dirname(statusPath), reference);
      relativePath = relativeSlash(root, absolute);
      resolveInside(root, relativePath);
    } catch {
      issues.push({
        code: "INVALID_RELATED_RECORD_PATH",
        severity: "warning",
        message: "卷状态表包含不安全的相关记录路径",
        path: statusPath,
        details: { reference },
      });
      continue;
    }
    const kind = relatedRecordKind(relativePath);
    if (!kind) {
      issues.push({
        code: "UNSUPPORTED_RELATED_RECORD_PATH",
        severity: "warning",
        message: "卷状态表的相关记录不在生产、审稿或发布目录",
        path: statusPath,
        details: { reference, relativePath },
      });
      continue;
    }
    if (seen.has(relativePath)) continue;
    const metadata = await stat(resolveInside(root, relativePath)).catch(
      () => null,
    );
    if (!metadata?.isFile()) {
      issues.push({
        code: "MISSING_RELATED_RECORD",
        severity: "warning",
        message: "卷状态表引用的相关记录不存在",
        path: statusPath,
        details: { reference, relativePath },
      });
      continue;
    }
    seen.add(relativePath);
    records.push({
      kind,
      path: relativePath,
      title: path.posix.basename(
        relativePath,
        path.posix.extname(relativePath),
      ),
    });
  }
  return { records, issues };
}

/** 读取卷详情、聚合统计和仓库内显式关联记录。 */
export async function readVolumeDetail(
  root: string,
  volumeId: string,
  currentChapterId?: string,
): Promise<VolumeDetail> {
  const index = await readRepositoryIndex(root);
  const volume = index.volumes.find((item) => item.id === volumeId);
  if (!volume) throw new AppError("VOLUME_NOT_FOUND", "未找到所选卷", 404);

  const statusCounts: Record<string, number> = {
    draft: 0,
    "ai-revised": 0,
    "human-revising": 0,
    final: 0,
  };
  for (const chapter of volume.chapters) {
    statusCounts[chapter.status] = (statusCounts[chapter.status] ?? 0) + 1;
  }
  const first = volume.chapters[0];
  const last = volume.chapters.at(-1);
  const outlinePath = `20_规划/卷/${volume.id}/卷纲.md`;
  const outlineMetadata = await stat(resolveInside(root, outlinePath)).catch(
    () => null,
  );
  const statusSource = await readVolumeStatusSource(root, volumeId);
  const related = statusSource
    ? await resolveRelatedRecords(
        root,
        statusSource.path,
        statusSource.historicalReviewRecords,
      )
    : { records: [], issues: [] };

  return {
    ...volume,
    totalWordCount: volume.chapters.reduce(
      (total, chapter) => total + chapter.wordCount,
      0,
    ),
    statusCounts,
    firstChapter: first ? chapterLink(volume, first) : undefined,
    lastChapter: last ? chapterLink(volume, last) : undefined,
    currentChapterId:
      currentChapterId &&
      volume.chapters.some((chapter) => chapter.id === currentChapterId)
        ? currentChapterId
        : undefined,
    outline: outlineMetadata?.isFile()
      ? { path: outlinePath, title: `${volume.title}卷纲` }
      : undefined,
    relatedRecords: related.records,
    healthIssues: [
      ...index.health.issues.filter((issue) => issue.volumeId === volumeId),
      ...related.issues,
    ],
  };
}

/** 按卷和全书唯一章 ID 延迟读取单章正文。 */
export async function readChapterDetail(
  root: string,
  volumeId: string,
  chapterId: string,
): Promise<ChapterDetail> {
  const index = await readRepositoryIndex(root);
  const sequence = index.volumes.flatMap((volume) =>
    volume.chapters.map((chapter) => ({ volume, chapter })),
  );
  const selectedIndex = sequence.findIndex(
    ({ volume, chapter }) => volume.id === volumeId && chapter.id === chapterId,
  );
  const selected = sequence[selectedIndex];
  if (!selected) throw new AppError("CHAPTER_NOT_FOUND", "未找到所选章节", 404);
  const { volume, chapter } = selected;
  const previous = sequence[selectedIndex - 1];
  const next = sequence[selectedIndex + 1];
  const content = await readUtf8(resolveInside(root, chapter.path));
  return {
    ...chapter,
    volumeId,
    chapterId,
    volume: {
      id: volume.id,
      number: volume.number,
      title: volume.title,
    },
    content,
    sourceHash: sha256(content),
    previous: previous
      ? chapterLink(previous.volume, previous.chapter)
      : undefined,
    next: next ? chapterLink(next.volume, next.chapter) : undefined,
    healthIssues: index.health.issues.filter(
      (issue) =>
        issue.volumeId === volumeId &&
        (!issue.chapterId || issue.chapterId === chapterId),
    ),
  };
}

async function fileCount(root: string, pattern: string): Promise<number> {
  return (await fg(pattern, { cwd: root, onlyFiles: true })).length;
}

/** 汇总创作、连续性与只读 Git 信息。 */
export async function getDashboard(
  root: string,
  currentTask?: DashboardData["currentTask"],
): Promise<DashboardData> {
  const [index, git, characterFiles, activeForeshadowFiles, timelineFiles] =
    await Promise.all([
      readRepositoryIndex(root),
      getGitStatus(root),
      fileCount(root, "10_圣经/人物/**/*.md"),
      fileCount(root, "10_圣经/伏笔/**/*.md"),
      fileCount(root, "10_圣经/时间线/**/*.md"),
    ]);
  return {
    repositoryRoot: root,
    projectName: path.basename(root),
    volumes: index.volumes,
    currentTask,
    health: index.health,
    git,
    continuity: {
      characterFiles,
      activeForeshadowFiles,
      timelineFiles,
      unresolvedReviewItems: currentTask?.pendingDecisionCount ?? 0,
    },
  };
}

export function authorityFor(
  relativePath: string,
): ContextCandidate["authority"] {
  if (relativePath.startsWith("40_正文/")) return "canonical";
  if (relativePath.startsWith("10_圣经/")) return "bible";
  if (relativePath.startsWith("30_生产/")) return "production";
  if (relativePath.startsWith("50_审稿/")) return "review";
  if (relativePath.startsWith("60_发布/")) return "production";
  if (relativePath.startsWith("70_素材/")) return "material";
  if (relativePath.startsWith("99_归档/")) return "archive";
  if (relativePath.startsWith("20_规划/") && /批准|已确认/.test(relativePath))
    return "approved-plan";
  return "plan";
}

/** 搜索 Markdown；结果按权威等级排序，并为归档内容附加警告。 */
export async function searchDocuments(
  root: string,
  query: string,
  limit = 80,
): Promise<Array<ContextCandidate & { excerpt: string }>> {
  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  const files = await fg(
    [
      "{10_圣经,20_规划,30_生产,40_正文,50_审稿,60_发布,70_素材,99_归档}/**/*.md",
    ],
    { cwd: root, onlyFiles: true, followSymbolicLinks: false },
  );
  const rank: Record<ContextCandidate["authority"], number> = {
    canonical: 0,
    bible: 1,
    "approved-plan": 2,
    plan: 3,
    production: 4,
    review: 5,
    material: 6,
    archive: 7,
  };
  const found: Array<ContextCandidate & { excerpt: string }> = [];
  for (const file of files) {
    const authority = authorityFor(file);
    if (!normalized) {
      found.push({
        path: file,
        label: path.posix.basename(file, ".md"),
        authority,
        selected: false,
        reason: "文档索引",
        warning:
          authority === "archive" ? "归档内容不是当前事实来源" : undefined,
        excerpt: "",
      });
      continue;
    }
    let content: string;
    try {
      content = (await readDocument(root, file)).content;
    } catch {
      continue;
    }
    const index = `${file}\n${content}`
      .toLocaleLowerCase("zh-CN")
      .indexOf(normalized);
    if (index < 0) continue;
    found.push({
      path: file,
      label: path.posix.basename(file, ".md"),
      authority,
      selected: false,
      reason: "搜索命中",
      warning: authority === "archive" ? "归档内容不是当前事实来源" : undefined,
      excerpt: content
        .slice(Math.max(0, index - 80), index + normalized.length + 160)
        .replace(/\s+/g, " "),
    });
  }
  return found
    .sort(
      (a, b) =>
        rank[a.authority] - rank[b.authority] ||
        a.path.localeCompare(b.path, "zh-CN"),
    )
    .slice(0, limit);
}

/** 返回单个仓库文件；只允许读取 Markdown/YAML/JSON/TXT。 */
export async function readDocument(
  root: string,
  relativePath: string,
): Promise<DocumentDetail> {
  // 先保留统一仓库边界错误，再判断是否属于受支持的文档类型。
  const absolute = resolveInside(root, relativePath);
  const safePath = DocumentPathSchema.safeParse(relativePath);
  assert(
    safePath.success,
    "UNSUPPORTED_DOCUMENT",
    "仅支持安全的 Markdown 文档",
  );
  const policy = documentPolicy(relativePath);
  assert(
    policy?.capabilities.readable,
    "DOCUMENT_AUTHORITY_NOT_ALLOWED",
    "此路径不在文档库读取范围",
  );
  await access(absolute).catch(() => {
    throw new AppError("DOCUMENT_NOT_FOUND", "文档不存在", 404);
  });
  const metadata = await lstat(absolute);
  assert(
    metadata.isFile() && !metadata.isSymbolicLink(),
    "UNSAFE_DOCUMENT_PATH",
    "文档必须是普通文件",
    409,
  );
  const normalizedPath = relativeSlash(root, absolute);
  const content = await readFile(absolute, "utf8");
  return {
    path: normalizedPath,
    content,
    sourceHash: sha256(content),
    authority: authorityFor(normalizedPath),
    capabilities: policy.capabilities,
    modifiedAt: metadata.mtime.toISOString(),
    size: metadata.size,
    warning: policy.warning,
  };
}

/** 读取受支持 Markdown 的安全目录树；符号链接和 junction 不进入树。 */
export async function readDocumentTree(
  root: string,
): Promise<DocumentTreeNode[]> {
  const roots = [
    "10_圣经",
    "20_规划",
    "30_生产",
    "40_正文",
    "50_审稿",
    "60_发布",
    "70_素材",
    "99_归档",
  ];
  const visit = async (relative: string): Promise<DocumentTreeNode | null> => {
    const absolute = resolveInside(root, relative);
    const metadata = await lstat(absolute).catch(() => null);
    if (!metadata || metadata.isSymbolicLink()) return null;
    const policy = documentPolicy(relative);
    if (!policy) return null;
    if (metadata.isFile()) {
      if (!/\.md$/i.test(relative)) return null;
      return {
        kind: "file",
        name: path.posix.basename(relative),
        path: relative,
        authority: authorityFor(relative),
        capabilities: policy.capabilities,
        warning: policy.warning,
        modifiedAt: metadata.mtime.toISOString(),
        size: metadata.size,
      };
    }
    if (!metadata.isDirectory()) return null;
    const entries = await readdir(absolute, { withFileTypes: true });
    const children = (
      await Promise.all(
        entries
          .filter((entry) => !entry.isSymbolicLink())
          .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))
          .map((entry) => visit(`${relative}/${entry.name}`)),
      )
    ).filter((entry): entry is DocumentTreeNode => entry !== null);
    return {
      kind: "directory",
      name: path.posix.basename(relative),
      path: relative,
      authority: authorityFor(`${relative}/`),
      capabilities: {
        ...policy.capabilities,
        readable: true,
        editable: false,
        archivable: false,
      },
      warning: policy.warning,
      children,
    };
  };
  return (await Promise.all(roots.map((item) => visit(item)))).filter(
    (entry): entry is DocumentTreeNode => entry !== null,
  );
}
