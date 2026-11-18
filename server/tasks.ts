import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import archiver from "archiver";
import { diffLines } from "diff";
import yaml from "js-yaml";
import * as unzipper from "unzipper";
import type {
  ContextCandidate,
  DecisionStatus,
  FinalConfirmation,
  ProductionTaskSummary,
  ReviewIssue,
  ReviewSeverity,
  RevisionAnalysis,
  TaskStage,
  TextChange,
  WritePreview,
} from "../shared/contracts.js";
import { AppError, assert } from "./errors.js";
import { validateChapterContent } from "./chapter-content.js";
import {
  atomicWrite,
  readUtf8,
  relativeSlash,
  resolveInside,
  sha256,
} from "./files.js";
import {
  commitMutation,
  invalidateMutationPreviews,
  prepareMutation,
  withRepositoryWriteGuard,
} from "./mutations/index.js";
import {
  authorityFor,
  invalidateRepositoryReadModel,
  readRepositoryIndex,
  readVolumes,
} from "./repository.js";

interface TaskRecord extends ProductionTaskSummary {
  sourcePath: string;
  statusPath: string;
  selectedContextPaths?: string[];
  finalConfirmation?: FinalConfirmation;
}
interface StatusRange {
  chapters: string;
  status: string;
  human_approved?: boolean;
  review_gate?: string;
  note?: string;
}
interface StatusDocument {
  status_ranges?: StatusRange[];
  [key: string]: unknown;
}

const stageActions: Record<TaskStage, string> = {
  created: "选择上下文并生成 ChatGPT 审查任务包",
  "context-ready": "导入 ChatGPT 审稿报告",
  "review-imported": "逐条完成人工决策",
  "decisions-recorded": "导入 AI 修订稿",
  "revision-imported": "进行人工终审",
  "human-final-review": "完成五项终稿确认",
  "ready-to-write": "预览正式正文和状态表变更",
  written: "归档生产任务",
  archived: "任务已完成",
};

function taskRoot(root: string): string {
  return path.join(root, "30_生产", "active");
}
function taskFile(root: string, id: string): string {
  return path.join(taskRoot(root), id, "task.yaml");
}
function archivedTaskRoot(root: string): string {
  return path.join(root, "30_生产", "archive");
}
function archivedTaskFile(root: string, id: string): string {
  return path.join(archivedTaskRoot(root), id, "task.yaml");
}
function now(): string {
  return new Date().toISOString();
}
function chapterNumber(id: string): number {
  return Number(id.match(/\d+/)?.[0] ?? 0);
}
function stageIndex(stage: TaskStage): number {
  return Object.keys(stageActions).indexOf(stage);
}

async function recordedContextPaths(
  root: string,
  task: TaskRecord,
): Promise<string[] | undefined> {
  if (task.selectedContextPaths) return task.selectedContextPaths;
  const legacyZip = resolveInside(
    root,
    path.posix.join(task.directory, "02_ChatGPT审查上下文.zip"),
  );
  try {
    const archive = await unzipper.Open.file(legacyZip);
    const manifest = archive.files.find(
      (entry) => entry.type === "File" && entry.path === "manifest.json",
    );
    if (!manifest || manifest.uncompressedSize > 1_000_000) return undefined;
    const parsed = JSON.parse((await manifest.buffer()).toString("utf8")) as {
      files?: unknown;
    };
    return Array.isArray(parsed.files) &&
      parsed.files.every((file): file is string => typeof file === "string")
      ? parsed.files
      : undefined;
  } catch {
    return undefined;
  }
}

async function saveTask(root: string, task: TaskRecord): Promise<void> {
  const persisted = persistedTask(task);
  Object.assign(task, persisted);
  await atomicWrite(taskFile(root, task.id), serializeTask(persisted));
}

async function saveTaskAtDirectory(
  directory: string,
  task: TaskRecord,
): Promise<void> {
  const persisted = persistedTask(task);
  Object.assign(task, persisted);
  await atomicWrite(
    path.join(directory, "task.yaml"),
    serializeTask(persisted),
  );
}

function persistedTask(task: TaskRecord): TaskRecord {
  return {
    ...task,
    updatedAt: now(),
    nextAction: stageActions[task.stage],
  };
}

function serializeTask(task: TaskRecord): string {
  return yaml.dump(task, { noRefs: true, lineWidth: 120 });
}

/** 加载任务元数据。 */
export async function getTask(root: string, id: string): Promise<TaskRecord> {
  assert(/^[\w-]+$/.test(id), "INVALID_TASK_ID", "生产任务 ID 不合法", 400);
  const locations = [
    {
      kind: "active" as const,
      file: taskFile(root, id),
      directory: path.posix.join("30_生产/active", id),
    },
    {
      kind: "archive" as const,
      file: archivedTaskFile(root, id),
      directory: path.posix.join("30_生产/archive", id),
    },
  ];
  const existing: typeof locations = [];
  for (const location of locations) {
    try {
      await access(location.file);
      existing.push(location);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  assert(existing.length > 0, "TASK_NOT_FOUND", "生产任务不存在", 404);
  assert(
    existing.length === 1,
    "DUPLICATE_TASK_ID",
    "活动区与归档区存在重复生产任务 ID",
    409,
  );
  const [location] = existing;
  const content = await readUtf8(location!.file).catch(() => {
    throw new AppError("TASK_NOT_FOUND", "生产任务不存在", 404);
  });
  const task = yaml.load(content) as TaskRecord;
  assert(
    task &&
      task.id === id &&
      task.directory === location!.directory &&
      (location!.kind === "archive"
        ? task.stage === "archived"
        : task.stage !== "archived"),
    "TASK_IDENTITY_MISMATCH",
    "生产任务元数据与物理位置身份不一致",
    409,
  );
  return task;
}

export async function listTasks(root: string): Promise<TaskRecord[]> {
  const { default: fg } = await import("fast-glob");
  const [activeFiles, archivedFiles] = await Promise.all([
    fg("*/task.yaml", { cwd: taskRoot(root), onlyFiles: true }).catch(() => []),
    fg("*/task.yaml", {
      cwd: archivedTaskRoot(root),
      onlyFiles: true,
    }).catch(() => []),
  ]);
  const ids = [...activeFiles, ...archivedFiles].map(
    (file) => file.split("/")[0]!,
  );
  assert(
    new Set(ids).size === ids.length,
    "DUPLICATE_TASK_ID",
    "活动区与归档区存在重复生产任务 ID",
    409,
  );
  return Promise.all(ids.map((id) => getTask(root, id))).then((tasks) =>
    tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  );
}

/** 创建任务并立即保存输入正文快照；终稿需显式允许开启新一轮。 */
async function createTaskUnlocked(
  root: string,
  volumeId: string,
  chapterId: string,
  allowFinalRevision = false,
): Promise<TaskRecord> {
  const volumes = await readVolumes(root);
  const volume = volumes.find((item) => item.id === volumeId);
  const chapter = volume?.chapters.find((item) => item.id === chapterId);
  assert(volume && chapter, "CHAPTER_NOT_FOUND", "未找到所选卷章", 404);
  assert(
    chapter.status !== "final" || allowFinalRevision,
    "FINAL_REVISION_REQUIRES_CONFIRMATION",
    "终稿必须显式创建新一轮修订任务",
  );
  const existing = (await listTasks(root)).find(
    (task) =>
      task.volumeId === volumeId &&
      task.chapterId === chapterId &&
      task.stage !== "archived",
  );
  assert(!existing, "ACTIVE_TASK_EXISTS", "该章节已有未结束任务", 409);
  const id = `${volumeId}-${chapterId}-${new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14)}`;
  const directory = path.posix.join("30_生产/active", id);
  const absoluteDirectory = resolveInside(root, directory);
  const stagingDirectory = path.posix.join(
    "30_生产/active",
    `.novel-task-${id}-${randomUUID()}`,
  );
  const absoluteStagingDirectory = resolveInside(root, stagingDirectory);
  try {
    await mkdir(path.dirname(absoluteStagingDirectory), { recursive: true });
    await mkdir(absoluteStagingDirectory);
    await copyFile(
      resolveInside(root, chapter.path),
      path.join(absoluteStagingDirectory, "01_输入快照.md"),
    );
    const statusPath = path.posix.join(
      path.posix.dirname(path.posix.dirname(chapter.path)),
      "状态.yaml",
    );
    const task: TaskRecord = {
      id,
      volumeId,
      chapterId,
      stage: "created",
      createdAt: now(),
      updatedAt: now(),
      directory,
      nextAction: stageActions.created,
      pendingDecisionCount: 0,
      sourcePath: chapter.path,
      statusPath,
    };
    await saveTaskAtDirectory(absoluteStagingDirectory, task);
    await atomicWrite(
      path.join(absoluteStagingDirectory, "00_任务说明.md"),
      `# ${chapter.title}终稿验收\n\n- 卷：${volume.title}\n- 章节：${chapter.id}\n- 创建时间：${task.createdAt}\n- 输入状态：${chapter.status}\n`,
    );
    // 只有全部工件准备完毕后才把目录发布到 active，避免中途中断留下可见半任务。
    await rename(absoluteStagingDirectory, absoluteDirectory);
    return task;
  } catch (error) {
    await rm(absoluteStagingDirectory, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw error;
  }
}

/** 根据章节相邻关系与权威目录生成可编辑上下文候选。 */
export async function contextCandidates(
  root: string,
  id: string,
): Promise<ContextCandidate[]> {
  const task = await getTask(root, id);
  const selectedContextPaths = await recordedContextPaths(root, task);
  const number = chapterNumber(task.chapterId);
  const volumes = await readVolumes(root);
  const volume = volumes.find((item) => item.id === task.volumeId)!;
  const fixed: Array<[string, string, string]> = [
    [
      "10_圣经/核心/修订风格卡.md",
      "修订风格卡",
      "向修订模型提供精简且稳定的文风约束",
    ],
    [
      `20_规划/卷/${task.volumeId}/修订上下文卡.md`,
      "当前卷修订上下文卡",
      "向修订模型提供当前卷状态与信息边界",
    ],
    ["10_圣经/核心/写作规范.md", "写作规范", "约束文风与格式"],
    ["10_圣经/核心/文学意义.md", "文学意义", "校验主题表达"],
    ["20_规划/全书/总纲.md", "全书总纲", "定位全书意图"],
    [
      `20_规划/卷/${path.posix.basename(path.posix.dirname(path.posix.dirname(task.sourcePath)))}/卷纲.md`,
      "当前卷纲",
      "定位本卷意图",
    ],
  ];
  for (const offset of [-1, 0, 1]) {
    const chapter = volume.chapters.find(
      (item) => item.number === number + offset,
    );
    if (chapter)
      fixed.push([
        chapter.path,
        offset < 0 ? "上一章" : offset > 0 ? "下一章" : "当前章",
        "检查章节内容与衔接",
      ]);
  }
  const { default: fg } = await import("fast-glob");
  const related = await fg(["10_圣经/{人物,世界,时间线,伏笔}/**/*.md"], {
    cwd: root,
    onlyFiles: true,
  });
  const candidates = [
    ...fixed.map(([file, label, reason]) => ({
      path: file,
      label,
      reason,
      selected: true,
    })),
    ...related.map((file) => ({
      path: file,
      label: path.posix.basename(file, ".md"),
      reason: "连续性资料",
      selected: true,
    })),
  ];
  const unique = new Map<string, ContextCandidate>();
  for (const item of candidates) {
    try {
      await access(resolveInside(root, item.path));
    } catch {
      continue;
    }
    const authority = authorityFor(item.path);
    unique.set(item.path, {
      ...item,
      selected: selectedContextPaths
        ? selectedContextPaths.includes(item.path)
        : item.selected,
      authority,
      warning:
        authority === "plan" ? "规划是创作意图，不等同于正文事实" : undefined,
    });
  }
  return [...unique.values()];
}

function reviewPrompt(task: TaskRecord): string {
  return `你是小说审稿助手。请只审查，不要改写正文。

目标章节：${task.volumeId}/${task.chapterId}
请依据包内文件的权威等级判断；正文与圣经优先于规划。

## 审查任务

以目标章节为主要审查对象。包内提供的相邻章节用于核对衔接，圣经用于核对正式规则，规划用于理解创作意图；不得把规划中尚未发生的内容当作正文事实。

在生成报告前，必须依次完成以下审查，不得在发现第一个问题后停止：

1. 正文内部一致性
   - 核对人物数量、身份、位置、伤势、物品归属、时间顺序和空间关系。
   - 核对同一动作是否被重复完成、已经结束的状态是否无故恢复。
   - 核对事件的原因、过程和结果是否闭合。
2. 相邻章节连续性
   - 对照包内提供的上一章、目标章节和下一章。
   - 核对人物状态、已知信息、动作进度、场景位置和关键事实是否连续。
   - 下一章尚未揭示的事实，不得反向认定为目标章节中的角色已知信息。
3. 圣经与设定一致性
   - 核对人物档案、能力限制、力量规则、时间线和伏笔资料。
   - 正文与圣经发生明确冲突时列为问题；规划与正文不同，不自动视为事实错误。
4. 人物与视角
   - 核对人物动机、行为选择和情绪反应是否有充分原因。
   - 核对限知视角是否稳定，人物是否知道其不可能知道的信息。
   - 区分人物立场、叙述事实和作者价值判断，不因角色持有争议立场就自动判为错误。
5. 结构与阅读体验
   - 核对场景目标、情节推进、信息顺序、节奏、重复说明和无效动作。
   - 检查重大事件是否产生了相应反应和后果。
6. 语言与格式
   - 检查语病、歧义、指代、专有名词、数字、标点和对白格式。
   - 语言问题不得掩盖更优先的人物、因果和设定问题。

## 证据与定级原则

- 只报告能够引用具体文本或正式设定证明的问题。
- 包内未提供某类资料时不得猜测；只完成现有资料支持的核查，不把资料缺失本身列为正文问题。
- 发现疑点后必须重新核对相关段落，避免根据记忆、关键词或孤立句子下结论。
- 同一根本原因造成的多个表象应合并为一个问题，避免重复计数。
- 存在两种合理解释、需要作者意图才能判断的内容，原则上列为“可选建议”，并明确说明不确定性。
- 不得为了显得审查充分而编造问题；完整检查后没有问题可以如实写“本级无问题”。

严重程度按以下标准判断：

- 阻断问题：直接破坏核心设定、关键因果、人物身份或章节成立基础，不修复则不建议进入终稿。
- 重要问题：明显影响人物动机、连续性、视角、情节可信度或核心阅读理解。
- 轻微问题：局部表达、数量措辞、重复、歧义或格式问题，不影响章节主体成立。
- 可选建议：不存在明确错误，只是可能改善节奏、表达或主题呈现。

## 提交前复核

输出前再次确认：

1. 已检查目标章节全文，而不是只检查关键词命中的段落。
2. 已对照包内提供的上一章和下一章的开头、结尾及相关事实。
3. 已核对人物数量、动作状态、已知信息和能力限制。
4. 每个问题都有可定位证据，严重程度与实际影响相符。
5. 四级问题数量与审查结论完全一致。

只输出最终审稿报告，不输出上述检查过程或内部推理。

## 输出格式（必须严格遵守）

先写“## 审查结论”，用普通段落概述是否建议通过，并分别给出阻断、重要、轻微、可选问题的数量。

随后严格按以下四个一级标题输出，顺序和名称不得改变：

# 一、阻断问题
# 二、重要问题
# 三、轻微问题
# 四、可选建议

每个问题必须使用下面的固定结构：

## 1. 清晰、可独立理解的问题标题
**证据**
- \`文件或章节定位\`：具体事实

**影响**
说明这会对事实一致性、人物动机、情节因果或阅读体验造成什么影响。

**建议**
说明应如何处理，但不要给出整章改写稿。

格式约束：
1. 一个“## 序号. 标题”只代表一个问题；证据、影响、建议中的列表都属于该问题，不得另起问题。
2. 每个问题必须同时包含“证据、影响、建议”三个小节；没有可核查证据的内容不要列为问题。
3. 某一级别没有问题时，只写“本级无问题。”，不要编造占位问题。
4. 四级问题总数必须与“审查结论”中的数量一致。
5. 除上述结构外，不要增加其他问题清单或重复摘要。`;
}

/** 生成 UTF-8 上下文 ZIP 和可复制审查提示词。 */
async function buildContextPackageUnlocked(
  root: string,
  id: string,
  selectedPaths: string[],
): Promise<{ zipPath: string; promptPath: string; prompt: string }> {
  const task = await getTask(root, id);
  assert(
    stageIndex(task.stage) <= stageIndex("context-ready"),
    "INVALID_STAGE",
    "当前阶段不能重新生成上下文包",
  );
  assert(selectedPaths.length > 0, "EMPTY_CONTEXT", "至少选择一个上下文文件");
  assert(
    selectedPaths.includes(task.sourcePath),
    "MISSING_SOURCE_CONTEXT",
    "审查任务包必须包含目标章节",
  );
  const candidates = new Set(
    (await contextCandidates(root, id)).map((item) => item.path),
  );
  selectedPaths.forEach((file) =>
    assert(
      candidates.has(file),
      "INVALID_CONTEXT_FILE",
      `文件不在上下文候选中：${file}`,
    ),
  );
  const dir = resolveInside(root, task.directory);
  const zip = path.join(dir, "02_ChatGPT审查上下文.zip");
  const prompt = reviewPrompt(task);
  const promptPath = path.join(dir, "02_审查提示词.md");
  await atomicWrite(promptPath, prompt);
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(zip);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);
    archive.pipe(output);
    for (const file of selectedPaths)
      archive.file(
        file === task.sourcePath
          ? path.join(dir, "01_输入快照.md")
          : resolveInside(root, file),
        { name: file },
      );
    archive.append(
      JSON.stringify(
        { generatedAt: now(), taskId: id, files: selectedPaths },
        null,
        2,
      ),
      { name: "manifest.json" },
    );
    void archive.finalize();
  });
  task.selectedContextPaths = [...selectedPaths];
  task.stage = "context-ready";
  await saveTask(root, task);
  return {
    zipPath: path.posix.join(task.directory, path.basename(zip)),
    promptPath: path.posix.join(task.directory, path.basename(promptPath)),
    prompt,
  };
}

function severityOf(text: string): ReviewSeverity | undefined {
  if (/阻断|blocker/i.test(text)) return "blocker";
  if (/重要|important/i.test(text)) return "important";
  if (/轻微|minor/i.test(text)) return "minor";
  if (/可选|建议|optional/i.test(text)) return "optional";
  return undefined;
}

type ReviewPart = "evidence" | "impact" | "suggestion";

interface ReviewIssueDraft {
  severity: ReviewSeverity;
  title: string;
  evidence: string[];
  impact: string[];
  suggestion: string[];
}

function stripListMarker(line: string): string {
  return line.replace(/^\s*(?:[-*+] |\d+[.)、．]\s+)/, "").trim();
}

function joinReviewLines(lines: string[]): string {
  return lines
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && line.trim() !== "---")
    .join("\n");
}

/**
 * 解析固定格式审稿报告。二级问题标题是唯一的问题边界，问题内部的
 * 证据、影响和建议列表不会被错误拆成新的代办项。
 */
export function parseReviewIssues(raw: string): ReviewIssue[] {
  const drafts: ReviewIssueDraft[] = [];
  let severity: ReviewSeverity = "important";
  let draft: ReviewIssueDraft | undefined;
  let part: ReviewPart | undefined;

  const finishDraft = () => {
    if (draft) drafts.push(draft);
    draft = undefined;
    part = undefined;
  };

  for (const sourceLine of raw.split(/\r?\n/)) {
    const line = sourceLine.trim();
    const severityHeading = line.match(/^#(?!#)\s+(.+)$/)?.[1];
    const nextSeverity = severityHeading
      ? severityOf(severityHeading)
      : undefined;
    if (nextSeverity) {
      finishDraft();
      severity = nextSeverity;
      continue;
    }

    const issueHeading = line.match(
      /^##\s+(?:\d+[.)、．]\s*|ISSUE-\d+\s*[:：-]?\s*)(.+)$/i,
    )?.[1];
    if (issueHeading?.trim()) {
      finishDraft();
      draft = {
        severity,
        title: issueHeading.trim().slice(0, 120),
        evidence: [],
        impact: [],
        suggestion: [],
      };
      continue;
    }
    if (!draft) continue;

    const partHeading = line.match(
      /^(?:#{3,6}\s*)?(?:\*\*|__)?(证据|影响|建议)(?:\*\*|__)?\s*[:：]?\s*(.*)$/,
    );
    if (partHeading) {
      part =
        partHeading[1] === "证据"
          ? "evidence"
          : partHeading[1] === "影响"
            ? "impact"
            : "suggestion";
      const inlineContent = partHeading[2]?.trim();
      if (inlineContent) draft[part].push(inlineContent);
      continue;
    }

    if (!line || line === "---") continue;
    if (!part && /^建议\s*[:：]/.test(line)) part = "suggestion";
    const target = part ?? "impact";
    draft[target].push(sourceLine);
  }
  finishDraft();

  if (drafts.length > 0) {
    return drafts.map((item, index) => ({
      id: `issue-${String(index + 1).padStart(3, "0")}`,
      severity: item.severity,
      title: item.title,
      evidence: item.evidence.map(stripListMarker).filter(Boolean),
      impact: joinReviewLines(item.impact),
      suggestion: joinReviewLines(item.suggestion),
    }));
  }

  // 已有任务可能是旧版简单列表报告；没有固定问题标题时再使用窄回退。
  const issues: ReviewIssue[] = [];
  for (const sourceLine of raw.split(/\r?\n/)) {
    const line = sourceLine.trim();
    const headingSeverity = /^#{1,6}\s*/.test(line)
      ? severityOf(line)
      : undefined;
    if (headingSeverity) {
      severity = headingSeverity;
      continue;
    }
    const text = line.match(/^(?:[-*+] |\d+[.)]\s+)(.+)$/)?.[1]?.trim();
    if (!text) continue;
    issues.push({
      id: `issue-${String(issues.length + 1).padStart(3, "0")}`,
      severity: severityOf(text) ?? severity,
      title: text.slice(0, 80),
      detail: text,
    });
  }
  return issues;
}

async function importReviewUnlocked(
  root: string,
  id: string,
  raw: string,
): Promise<ReviewIssue[]> {
  const task = await getTask(root, id);
  assert(
    task.stage === "context-ready" || task.stage === "review-imported",
    "INVALID_STAGE",
    "当前阶段不能保存并解析审稿报告",
  );
  assert(raw.trim(), "EMPTY_REVIEW", "审稿报告不能为空");
  const issues = parseReviewIssues(raw);
  const dir = resolveInside(root, task.directory);
  await atomicWrite(path.join(dir, "03_审稿报告_原文.md"), raw);
  await atomicWrite(
    path.join(dir, "03_审稿问题.yaml"),
    yaml.dump(
      { parsedAt: now(), parseSucceeded: issues.length > 0, issues },
      { noRefs: true, lineWidth: 120 },
    ),
  );
  task.stage = "review-imported";
  task.pendingDecisionCount = issues.length;
  await saveTask(root, task);
  return issues;
}

export async function getIssues(
  root: string,
  id: string,
): Promise<ReviewIssue[]> {
  const task = await getTask(root, id);
  const file = path.join(
    resolveInside(root, task.directory),
    "03_审稿问题.yaml",
  );
  const document = yaml.load(
    await readUtf8(file).catch(() => "issues: []"),
  ) as { issues?: ReviewIssue[] };
  return document.issues ?? [];
}

async function recordDecisionsUnlocked(
  root: string,
  id: string,
  decisions: Array<{ id: string; decision: DecisionStatus; note?: string }>,
  revisionInstructionAdditions: string[] = [],
): Promise<{ issues: ReviewIssue[]; prompt: string }> {
  const task = await getTask(root, id);
  assert(
    task.stage === "review-imported" || task.stage === "decisions-recorded",
    "INVALID_STAGE",
    "当前阶段不能记录问题决策",
  );
  const issues = await getIssues(root, id);
  const byId = new Map(decisions.map((decision) => [decision.id, decision]));
  for (const issue of issues) {
    const decision = byId.get(issue.id);
    if (decision) {
      issue.decision = decision.decision;
      issue.decisionNote = decision.note;
    }
  }
  const pending = issues.filter(
    (issue) => !issue.decision || issue.decision === "later",
  ).length;
  const approved = issues.filter(
    (issue) =>
      issue.decision === "approved" || issue.decision === "partially-approved",
  );
  const extraOutputRequirements = [
    ...new Set(
      revisionInstructionAdditions.map((item) => item.trim()).filter(Boolean),
    ),
  ];
  const prompt = `请修订 ${task.chapterId} 并返回完整章节正文。

人工决策记录是本轮修改范围的唯一权威；审稿报告只用于理解问题的证据、影响和建议。不得采纳被拒绝或稍后决定的问题，部分批准项只能在作者备注限定范围内处理。除已批准范围外，不得改动情节、人物动机、设定、伏笔和关键事实。

## 已批准的修改要求

${approved.map((issue) => `- ${issue.title}${issue.decisionNote ? `（限制：${issue.decisionNote}）` : ""}`).join("\n") || "- 本轮没有已批准的修改要求；请原样返回原章节正文"}

## 输出要求

- 保留原章节 Markdown 一级标题，返回可直接导入的完整章节正文。
- 不要输出修改说明、审稿意见、差异摘要或代码围栏。
- 相关资料只用于约束事实和文风，不得据此新增原稿中不存在的情节。
- 请严格遵守写作规范，尤其是标点的使用应当使用中文标点，如双引号、逗号和句号等。${
    extraOutputRequirements.length
      ? `\n${extraOutputRequirements.map((item) => `- ${item}`).join("\n")}`
      : ""
  }`;
  const dir = resolveInside(root, task.directory);
  await atomicWrite(
    path.join(dir, "04_人工决策.yaml"),
    yaml.dump({ recordedAt: now(), issues }, { noRefs: true, lineWidth: 120 }),
  );
  await atomicWrite(path.join(dir, "04_修订提示词.md"), prompt);
  task.pendingDecisionCount = pending;
  if (pending === 0) task.stage = "decisions-recorded";
  await saveTask(root, task);
  return { issues, prompt };
}

interface RevisionPackageEntry {
  path: string;
  source: string;
  content: Buffer;
}

const MAX_REVISION_PACKAGE_SOURCE_BYTES = 50 * 1024 * 1024;

function safePackagePath(prefix: string, sourcePath: string): string {
  const normalized = path.posix.normalize(sourcePath);
  assert(
    normalized === sourcePath &&
      !path.posix.isAbsolute(sourcePath) &&
      !sourcePath.startsWith("../") &&
      !sourcePath.includes("\\") &&
      !sourcePath.includes("\0") &&
      !/^[A-Za-z]:/.test(sourcePath),
    "INVALID_CONTEXT_ARCHIVE",
    `审查上下文包含不安全路径：${sourcePath}`,
  );
  return path.posix.join(prefix, sourcePath);
}

async function createRevisionZip(
  entries: RevisionPackageEntry[],
  metadata: {
    taskId: string;
    volumeId: string;
    chapterId: string;
    sourceContextSha256: string;
    packageType: "full-audit" | "compact-revision";
  },
): Promise<Buffer> {
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  const archive = archiver("zip", { zlib: { level: 9 } });
  const completed = new Promise<void>((resolve, reject) => {
    output.on("end", resolve);
    output.on("error", reject);
    archive.on("error", reject);
  });
  archive.pipe(output);
  for (const entry of entries)
    archive.append(entry.content, { name: entry.path });
  archive.append(
    JSON.stringify(
      {
        schemaVersion: 1,
        ...metadata,
        generatedAt: now(),
        sourceReviewPackage: "02_ChatGPT审查上下文.zip",
        files: entries.map((entry) => ({
          path: entry.path,
          source: entry.source,
          sha256: sha256(entry.content),
        })),
      },
      null,
      2,
    ),
    { name: "manifest.json" },
  );
  void archive.finalize();
  await completed;
  return Buffer.concat(chunks);
}

interface FrozenRevisionContext {
  task: TaskRecord;
  directory: string;
  decidedIssues: ReviewIssue[];
  reviewZipPath: string;
  selectedPaths: string[];
  sourceArchive: unzipper.CentralDirectory;
  snapshot: Buffer;
  sourceContextSha256: string;
}

async function loadFrozenRevisionContext(
  root: string,
  id: string,
): Promise<FrozenRevisionContext> {
  const task = await getTask(root, id);
  assert(
    task.stage === "decisions-recorded",
    "INVALID_STAGE",
    "所有问题完成决策后才能生成修订任务包",
  );
  const directory = resolveInside(root, task.directory);
  let decidedIssues: ReviewIssue[];
  try {
    const decisionsDocument = yaml.load(
      await readUtf8(path.join(directory, "04_人工决策.yaml")),
    ) as { issues?: unknown };
    assert(
      Array.isArray(decisionsDocument.issues),
      "INVALID_DECISION_RECORD",
      "人工决策记录缺少问题列表",
    );
    decidedIssues = decisionsDocument.issues as ReviewIssue[];
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("INVALID_DECISION_RECORD", "人工决策记录无法读取");
  }
  assert(
    task.pendingDecisionCount === 0 &&
      decidedIssues.every(
        (issue) => issue.decision && issue.decision !== "later",
      ),
    "PENDING_REVIEW_DECISIONS",
    "仍有问题尚未完成决策，不能生成修订任务包",
  );

  const reviewZipPath = path.join(directory, "02_ChatGPT审查上下文.zip");
  const selectedPaths = await recordedContextPaths(root, task);
  assert(
    selectedPaths?.length,
    "MISSING_REVIEW_CONTEXT",
    "缺少第三步审查上下文记录，请回退并重新生成审查任务包",
  );

  let sourceArchive: unzipper.CentralDirectory;
  try {
    sourceArchive = await unzipper.Open.file(reviewZipPath);
  } catch {
    throw new AppError(
      "MISSING_REVIEW_CONTEXT",
      "缺少第三步审查上下文包，请回退并重新生成",
    );
  }
  const sourceManifestEntries = sourceArchive.files.filter(
    (entry) => entry.type === "File" && entry.path === "manifest.json",
  );
  assert(
    sourceManifestEntries.length === 1 &&
      sourceManifestEntries[0]!.uncompressedSize <= 1_000_000,
    "INVALID_CONTEXT_ARCHIVE",
    "第三步审查上下文清单缺失、重复或过大",
  );
  let sourceManifest: { taskId?: unknown; files?: unknown };
  try {
    sourceManifest = JSON.parse(
      (await sourceManifestEntries[0]!.buffer()).toString("utf8"),
    ) as { taskId?: unknown; files?: unknown };
  } catch {
    throw new AppError(
      "INVALID_CONTEXT_ARCHIVE",
      "第三步审查上下文清单无法解析",
    );
  }
  assert(
    sourceManifest.taskId === id &&
      Array.isArray(sourceManifest.files) &&
      sourceManifest.files.length === selectedPaths.length &&
      sourceManifest.files.every(
        (file, index) => file === selectedPaths[index],
      ),
    "INVALID_CONTEXT_ARCHIVE",
    "第三步审查上下文清单与当前任务记录不一致",
  );

  const snapshot = await readFile(path.join(directory, "01_输入快照.md"));
  const sourceChapterEntries = sourceArchive.files.filter(
    (entry) => entry.type === "File" && entry.path === task.sourcePath,
  );
  assert(
    sourceChapterEntries.length === 1,
    "INVALID_CONTEXT_ARCHIVE",
    "第三步审查上下文缺少唯一的目标章节，请回退并重新生成",
  );
  assert(
    sha256(await sourceChapterEntries[0]!.buffer()) === sha256(snapshot),
    "CONTEXT_SNAPSHOT_MISMATCH",
    "第三步审查正文与任务输入快照不一致，请回退并重新生成",
  );

  return {
    task,
    directory,
    decidedIssues,
    reviewZipPath,
    selectedPaths,
    sourceArchive,
    snapshot,
    sourceContextSha256: sha256(await readFile(reviewZipPath)),
  };
}

async function readFrozenContextEntry(
  sourceArchive: unzipper.CentralDirectory,
  selectedPath: string,
): Promise<Buffer> {
  const sources = sourceArchive.files.filter(
    (entry) => entry.type === "File" && entry.path === selectedPath,
  );
  assert(
    sources.length === 1,
    "INVALID_CONTEXT_ARCHIVE",
    `第三步审查上下文缺少唯一的已记录资料：${selectedPath}`,
  );
  const source = sources[0]!;
  assert(
    source.uncompressedSize <= 20 * 1024 * 1024,
    "REVISION_PACKAGE_TOO_LARGE",
    `修订任务包中的单项资料超过 20 MiB：${selectedPath}`,
  );
  return source.buffer();
}

/** 依据审查时的资料快照生成可交给其他 AI 的第五步修订任务包。 */
async function buildRevisionPackageUnlocked(
  root: string,
  id: string,
): Promise<{ zipPath: string }> {
  const {
    task,
    directory: dir,
    selectedPaths,
    sourceArchive,
    snapshot,
    sourceContextSha256,
  } = await loadFrozenRevisionContext(root, id);

  const entries: RevisionPackageEntry[] = [];
  let relatedBytes = 0;
  for (const selectedPath of selectedPaths) {
    if (selectedPath === task.sourcePath) continue;
    const content = await readFrozenContextEntry(sourceArchive, selectedPath);
    relatedBytes += content.byteLength;
    assert(
      relatedBytes <= MAX_REVISION_PACKAGE_SOURCE_BYTES,
      "REVISION_PACKAGE_TOO_LARGE",
      "修订任务包中的相关资料超过 50 MiB",
    );
    entries.push({
      path: safePackagePath("相关资料", selectedPath),
      source: `02_ChatGPT审查上下文.zip:${selectedPath}`,
      content,
    });
  }

  const artifacts: Array<[string, string]> = [
    ["审稿/03_审稿报告_原文.md", "03_审稿报告_原文.md"],
    ["审稿/03_审稿问题.yaml", "03_审稿问题.yaml"],
    ["决策/04_人工决策.yaml", "04_人工决策.yaml"],
    ["04_修订提示词.md", "04_修订提示词.md"],
  ];
  entries.push({
    path: "原稿/01_输入快照.md",
    source: "01_输入快照.md",
    content: snapshot,
  });
  for (const [packagePath, artifactName] of artifacts) {
    let content: Buffer;
    try {
      content = await readFile(path.join(dir, artifactName));
    } catch {
      throw new AppError(
        "MISSING_REVISION_ARTIFACT",
        `缺少修订任务包所需工件：${artifactName}`,
      );
    }
    entries.push({ path: packagePath, source: artifactName, content });
  }

  const zip = path.join(dir, "04_AI修订上下文.zip");
  await atomicWrite(
    zip,
    await createRevisionZip(entries, {
      taskId: task.id,
      volumeId: task.volumeId,
      chapterId: task.chapterId,
      sourceContextSha256,
      packageType: "full-audit",
    }),
  );
  return { zipPath: relativeSlash(root, zip) };
}

const REVISION_STYLE_CARD_PATH = "10_圣经/核心/修订风格卡.md";

function volumeRevisionCardPath(task: TaskRecord): string {
  return `20_规划/卷/${task.volumeId}/修订上下文卡.md`;
}

function approvedDecisionDigest(issues: ReviewIssue[]): string {
  const approved = issues.filter(
    (issue) =>
      issue.decision === "approved" || issue.decision === "partially-approved",
  );
  const severityLabels: Record<ReviewSeverity, string> = {
    blocker: "阻断",
    important: "重要",
    minor: "轻微",
    optional: "可选",
  };
  const sections = approved.map((issue, index) => {
    const decisionLabel = issue.decision === "approved" ? "采纳" : "部分采纳";
    const evidence = issue.evidence?.length
      ? issue.evidence.map((item) => `- ${item}`).join("\n")
      : "- 未提供独立证据；以标题和建议限定修改范围。";
    return `## ${index + 1}. ${issue.title}

- 决策：${decisionLabel}
- 严重程度：${severityLabels[issue.severity]}
${issue.decisionNote ? `- 作者限制：${issue.decisionNote}` : ""}

### 证据

${evidence}

### 影响

${issue.impact?.trim() || "未单独记录。"}

### 建议

${issue.suggestion?.trim() || "按问题标题作最小必要修正。"}
`;
  });
  return `# 已批准修改

本文件是本轮修改范围的唯一决策摘要。只处理下列采纳或部分采纳项；未列出的问题均不得修改。部分采纳项必须服从“作者限制”。

${sections.join("\n") || "本轮没有已批准的修改；请原样返回章节正文。"}
`;
}

/**
 * 准备交给外部 AI 的最小充分上下文。ZIP 与单文件文本共用此结果，
 * 确保两种封装格式不会产生内容分叉。
 */
async function prepareCompactRevisionEntries(
  root: string,
  id: string,
): Promise<{
  task: TaskRecord;
  directory: string;
  entries: RevisionPackageEntry[];
  sourceContextSha256: string;
}> {
  const {
    task,
    directory,
    decidedIssues,
    selectedPaths,
    sourceArchive,
    snapshot,
    sourceContextSha256,
  } = await loadFrozenRevisionContext(root, id);
  const volumeCardPath = volumeRevisionCardPath(task);
  assert(
    selectedPaths.includes(REVISION_STYLE_CARD_PATH) &&
      selectedPaths.includes(volumeCardPath),
    "MISSING_COMPACT_CONTEXT_CARDS",
    "第三步未冻结修订风格卡或当前卷修订上下文卡，请回退到第二步重新生成审查任务包",
  );

  const entries: RevisionPackageEntry[] = [
    {
      path: "原稿/01_输入快照.md",
      source: "01_输入快照.md",
      content: snapshot,
    },
    {
      path: "上下文/修订风格卡.md",
      source: `02_ChatGPT审查上下文.zip:${REVISION_STYLE_CARD_PATH}`,
      content: await readFrozenContextEntry(
        sourceArchive,
        REVISION_STYLE_CARD_PATH,
      ),
    },
    {
      path: "上下文/当前卷修订上下文卡.md",
      source: `02_ChatGPT审查上下文.zip:${volumeCardPath}`,
      content: await readFrozenContextEntry(sourceArchive, volumeCardPath),
    },
  ];

  const chapterDirectory = `${path.posix.dirname(task.sourcePath)}/`;
  const adjacentChapterPaths = selectedPaths.filter(
    (selectedPath) =>
      selectedPath !== task.sourcePath &&
      selectedPath.startsWith(chapterDirectory) &&
      selectedPath.endsWith(".md"),
  );
  const topicalPaths = selectedPaths.filter(
    (selectedPath) =>
      /^10_圣经\/(?:人物|世界|时间线|伏笔)\/.+\.md$/.test(selectedPath) &&
      !selectedPath.endsWith("/README.md"),
  );
  let contextBytes = entries.reduce(
    (total, entry) => total + entry.content.byteLength,
    0,
  );
  for (const selectedPath of adjacentChapterPaths) {
    const content = await readFrozenContextEntry(sourceArchive, selectedPath);
    contextBytes += content.byteLength;
    assert(
      contextBytes <= MAX_REVISION_PACKAGE_SOURCE_BYTES,
      "REVISION_PACKAGE_TOO_LARGE",
      "精简修订包中的上下文超过 50 MiB",
    );
    entries.push({
      path: safePackagePath("相邻章节", path.posix.basename(selectedPath)),
      source: `02_ChatGPT审查上下文.zip:${selectedPath}`,
      content,
    });
  }
  for (const selectedPath of topicalPaths) {
    const content = await readFrozenContextEntry(sourceArchive, selectedPath);
    contextBytes += content.byteLength;
    assert(
      contextBytes <= MAX_REVISION_PACKAGE_SOURCE_BYTES,
      "REVISION_PACKAGE_TOO_LARGE",
      "精简修订包中的上下文超过 50 MiB",
    );
    entries.push({
      path: safePackagePath("专题资料", selectedPath),
      source: `02_ChatGPT审查上下文.zip:${selectedPath}`,
      content,
    });
  }

  let prompt: Buffer;
  try {
    prompt = await readFile(path.join(directory, "04_修订提示词.md"));
  } catch {
    throw new AppError(
      "MISSING_REVISION_ARTIFACT",
      "缺少修订任务包所需工件：04_修订提示词.md",
    );
  }
  entries.push(
    {
      path: "决策/已批准修改.md",
      source: "04_人工决策.yaml:approved-and-partially-approved",
      content: Buffer.from(approvedDecisionDigest(decidedIssues), "utf8"),
    },
    {
      path: "04_修订提示词.md",
      source: "04_修订提示词.md",
      content: prompt,
    },
  );
  return { task, directory, entries, sourceContextSha256 };
}

/**
 * 生成交给支持 ZIP 的外部 AI 的精简修订包。所有资料均来自第三步冻结包，
 * 避免审稿后仓库内容变化造成依据漂移。
 */
async function buildCompactRevisionPackageUnlocked(
  root: string,
  id: string,
): Promise<{ zipPath: string }> {
  const { task, directory, entries, sourceContextSha256 } =
    await prepareCompactRevisionEntries(root, id);
  const zip = path.join(directory, "04_AI修订精简包.zip");
  await atomicWrite(
    zip,
    await createRevisionZip(entries, {
      taskId: task.id,
      volumeId: task.volumeId,
      chapterId: task.chapterId,
      sourceContextSha256,
      packageType: "compact-revision",
    }),
  );
  return { zipPath: relativeSlash(root, zip) };
}

function compactRevisionText(
  task: TaskRecord,
  entries: RevisionPackageEntry[],
  sourceContextSha256: string,
): Buffer {
  const sections = entries.map((entry) => {
    const metadata = JSON.stringify({
      path: entry.path,
      bytes: entry.content.byteLength,
      sha256: sha256(entry.content),
    });
    const content = entry.content.toString("utf8");
    return `<!-- NOVEL_FILE_BEGIN ${metadata} -->
${content}${content.endsWith("\n") ? "" : "\n"}<!-- NOVEL_FILE_END ${JSON.stringify({ path: entry.path })} -->`;
  });
  return Buffer.from(
    `# 小说 AI 修订单文件任务包

- 任务：${task.id}
- 卷章：${task.volumeId}/${task.chapterId}
- 来源审查包 SHA-256：${sourceContextSha256}
- 生成时间：${now()}

## 使用说明

本文件用于不支持 ZIP、但支持文本文件上传的 AI。请从上到下读取全部内容，保留各文件的权威边界。只按“已批准修改”处理，不得采纳未列出的审稿意见，也不得依据上下文新增原稿不存在的情节、设定或人物动机。

每个来源使用 \`NOVEL_FILE_BEGIN\` 与 \`NOVEL_FILE_END\` 标记分隔；开始标记记录原路径、UTF-8 字节数和 SHA-256。

${sections.join("\n\n")}
`,
    "utf8",
  );
}

/** 生成兼容 DeepSeek 等不支持 ZIP 上传平台的 UTF-8 单文件任务包。 */
async function buildCompactTextRevisionPackageUnlocked(
  root: string,
  id: string,
): Promise<{ textPath: string }> {
  const { task, directory, entries, sourceContextSha256 } =
    await prepareCompactRevisionEntries(root, id);
  const textFile = path.join(directory, "04_AI修订精简单文件.txt");
  await atomicWrite(
    textFile,
    compactRevisionText(task, entries, sourceContextSha256),
  );
  return { textPath: relativeSlash(root, textFile) };
}

function textDiff(before: string, after: string): TextChange[] {
  return diffLines(before, after).map((part) => ({
    type: part.added ? "added" : part.removed ? "removed" : "unchanged",
    value: part.value,
    count: part.count,
  }));
}

function title(markdown: string): string {
  return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "";
}
function visibleLength(text: string): number {
  return text.replace(/\s/g, "").length;
}

/** 生成确定性文本 diff 与谨慎的启发式提示；提示不作自动裁决。 */
export function analyzeRevision(
  before: string,
  after: string,
  approvedIssueCount: number,
): RevisionAnalysis {
  const changes = textDiff(before, after);
  const beforeLength = Math.max(1, visibleLength(before));
  const added = changes
    .filter((part) => part.type === "added")
    .reduce((sum, part) => sum + visibleLength(part.value), 0);
  const removed = changes
    .filter((part) => part.type === "removed")
    .reduce((sum, part) => sum + visibleLength(part.value), 0);
  const newCanonPatterns = [
    ...after.matchAll(
      /(?:首次|从未有人知道|真正的名字|规则是|被称为|乃是)[^。！？\n]{2,50}/g,
    ),
  ].map((match) => match[0]);
  const continuityWarnings: string[] = [];
  if (!after.trim().startsWith("#"))
    continuityWarnings.push("修订稿缺少 Markdown 章节标题。");
  if (visibleLength(after) < beforeLength * 0.7)
    continuityWarnings.push("修订稿明显缩短，请核对是否删除重要信息。");
  return {
    changes,
    addedRatio: added / beforeLength,
    removedRatio: removed / beforeLength,
    titleChanged: title(before) !== title(after),
    possibleNewCanon: [...new Set(newCanonPatterns)].slice(0, 20),
    continuityWarnings,
    largeUnapprovedRewrite:
      (added + removed) / beforeLength > 0.35 && approvedIssueCount === 0,
  };
}

async function importRevisionUnlocked(
  root: string,
  id: string,
  content: string,
): Promise<RevisionAnalysis> {
  const task = await getTask(root, id);
  assert(
    task.stage === "decisions-recorded",
    "INVALID_STAGE",
    "所有问题完成决策后才能导入修订稿",
  );
  assert(content.trim(), "EMPTY_REVISION", "修订稿不能为空");
  validateChapterContent(content);
  const dir = resolveInside(root, task.directory);
  const before = await readUtf8(path.join(dir, "01_输入快照.md"));
  const issues = await getIssues(root, id);
  const approvedCount = issues.filter((issue) =>
    ["approved", "partially-approved"].includes(issue.decision ?? ""),
  ).length;
  const analysis = analyzeRevision(before, content, approvedCount);
  await atomicWrite(path.join(dir, "05_AI修订稿.md"), content);
  await atomicWrite(
    path.join(dir, "05_修订分析.json"),
    JSON.stringify(analysis, null, 2),
  );
  task.stage = "revision-imported";
  await saveTask(root, task);
  return analysis;
}

async function saveHumanFinalUnlocked(
  root: string,
  id: string,
  content: string,
): Promise<void> {
  const task = await getTask(root, id);
  assert(
    ["revision-imported", "human-final-review"].includes(task.stage),
    "INVALID_STAGE",
    "当前阶段不能保存人工终审稿",
  );
  assert(content.trim(), "EMPTY_FINAL", "人工终审稿不能为空");
  validateChapterContent(content);
  await atomicWrite(
    path.join(resolveInside(root, task.directory), "06_人工终审稿.md"),
    content,
  );
  task.stage = "human-final-review";
  await saveTask(root, task);
}

async function confirmFinalUnlocked(
  root: string,
  id: string,
  confirmation: FinalConfirmation,
): Promise<TaskRecord> {
  const task = await getTask(root, id);
  assert(
    task.stage === "human-final-review",
    "INVALID_STAGE",
    "请先保存人工终审稿",
  );
  assertFinalConfirmation(confirmation);
  task.finalConfirmation = confirmation;
  task.stage = "ready-to-write";
  await saveTask(root, task);
  return task;
}

function assertFinalConfirmation(confirmation: FinalConfirmation): void {
  assert(
    Object.values(confirmation).every(Boolean),
    "INCOMPLETE_FINAL_CONFIRMATION",
    "五项终稿确认必须全部由作者明确勾选",
  );
}

/** 组合保存人工终审稿并确认终稿；任何写入之前先完成五项确认校验。 */
async function completeHumanFinalUnlocked(
  root: string,
  id: string,
  content: string,
  confirmation: FinalConfirmation,
): Promise<TaskRecord> {
  assertFinalConfirmation(confirmation);
  await saveHumanFinalUnlocked(root, id, content);
  return confirmFinalUnlocked(root, id, confirmation);
}

function updateStatus(source: string, chapter: number): string {
  const document = yaml.load(source) as StatusDocument;
  const ranges = document.status_ranges ?? [];
  const next: StatusRange[] = [];
  let found = false;
  for (const range of ranges) {
    const numbers = [...range.chapters.matchAll(/ch(\d+)/g)].map((item) =>
      Number(item[1]),
    );
    const start = numbers[0] ?? 0,
      end = numbers[1] ?? start;
    if (chapter < start || chapter > end) {
      next.push(range);
      continue;
    }
    found = true;
    const id = (value: number) => `ch${String(value).padStart(3, "0")}`;
    if (start < chapter)
      next.push({ ...range, chapters: `${id(start)}-${id(chapter - 1)}` });
    next.push({
      chapters: id(chapter),
      status: "final",
      human_approved: true,
      note: "作者通过本地创作工作台确认终稿",
    });
    if (chapter < end)
      next.push({ ...range, chapters: `${id(chapter + 1)}-${id(end)}` });
  }
  assert(found, "STATUS_RANGE_NOT_FOUND", "状态表中未找到目标章节");
  document.status_ranges = next;
  return yaml.dump(document, { noRefs: true, lineWidth: 120 });
}

const rewindArtifactCutoff: Record<
  Exclude<TaskStage, "written" | "archived">,
  number
> = {
  created: 2,
  "context-ready": 3,
  "review-imported": 4,
  "decisions-recorded": 5,
  "revision-imported": 6,
  "human-final-review": 7,
  "ready-to-write": 7,
};

/**
 * 将未写入正式正文的任务安全回退到更早阶段。失效的下游工件会移入
 * 带时间戳的 history 目录，移动或元数据保存失败时恢复原位置。
 */
async function rewindTaskStageUnlocked(
  root: string,
  id: string,
  targetStage: TaskStage,
): Promise<TaskRecord> {
  const task = await getTask(root, id);
  const currentIndex = stageIndex(task.stage);
  const targetIndex = stageIndex(targetStage);
  assert(
    currentIndex < stageIndex("written") &&
      targetIndex >= 0 &&
      targetIndex < currentIndex,
    "INVALID_STAGE_REWIND",
    "只能将正式写入前的任务回退到更早阶段",
    409,
  );

  const target = targetStage as Exclude<TaskStage, "written" | "archived">;
  const taskDirectory = resolveInside(root, task.directory);
  const entries = await readdir(taskDirectory, { withFileTypes: true });
  const artifacts = entries
    .filter((entry) => entry.isFile())
    .filter((entry) => {
      const prefix = Number(entry.name.match(/^(\d{2})_/)?.[1] ?? -1);
      return prefix >= rewindArtifactCutoff[target] && prefix <= 7;
    })
    .map((entry) => entry.name);
  const historyDirectory = path.join(
    taskDirectory,
    "history",
    `rewind-${now().replace(/[-:.TZ]/g, "")}-${task.stage}-to-${target}-${randomUUID().slice(0, 8)}`,
  );
  if (
    targetIndex >= stageIndex("context-ready") &&
    !task.selectedContextPaths
  ) {
    task.selectedContextPaths = await recordedContextPaths(root, task);
  }
  if (target === "created") delete task.selectedContextPaths;
  delete task.finalConfirmation;
  task.pendingDecisionCount =
    target === "review-imported" ? (await getIssues(root, id)).length : 0;
  task.stage = target;
  const rewound = persistedTask(task);
  const operations = [] as Parameters<typeof prepareMutation>[1]["operations"];
  if (artifacts.length > 0) {
    const historyRoot = path.dirname(historyDirectory);
    const historyRootExists = await access(historyRoot)
      .then(() => true)
      .catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      });
    operations.push(
      historyRootExists
        ? {
            kind: "create-tree",
            path: relativeSlash(root, historyDirectory),
            entries: [],
          }
        : {
            kind: "create-tree",
            path: relativeSlash(root, historyRoot),
            entries: [
              {
                kind: "directory",
                path: path.basename(historyDirectory),
              },
            ],
          },
    );
    operations.push(
      ...artifacts.map((name) => ({
        kind: "move" as const,
        path: path.posix.join(task.directory, name),
        destinationPath: path.posix.join(
          relativeSlash(root, historyDirectory),
          name,
        ),
      })),
    );
  }
  operations.push({
    kind: "replace",
    path: path.posix.join(task.directory, "task.yaml"),
    content: serializeTask(rewound),
  });
  const ticket = await prepareMutation(root, {
    kind: `rewind-task:${id}:${target}`,
    operations,
  });
  await commitMutation(root, ticket.token, `rewind-task:${id}:${target}`);
  await invalidateMutationPreviews(root);
  return rewound;
}

/** 创建短时写入预览；不会修改正文或状态表。 */
export async function previewWrite(
  root: string,
  id: string,
): Promise<WritePreview> {
  const repository = await readRepositoryIndex(root);
  assert(
    repository.health.healthy,
    "REPOSITORY_HEALTH_BLOCKING",
    "仓库存在阻断级结构问题，不能生成正式写入预览",
    409,
  );
  const task = await getTask(root, id);
  assert(
    task.stage === "ready-to-write" &&
      task.finalConfirmation &&
      Object.values(task.finalConfirmation).every(Boolean),
    "NOT_READY_TO_WRITE",
    "任务尚未完成终稿确认",
  );
  const finalContent = await readUtf8(
    path.join(resolveInside(root, task.directory), "06_人工终审稿.md"),
  );
  validateChapterContent(finalContent);
  const before = await readUtf8(resolveInside(root, task.sourcePath));
  const statusBefore = await readUtf8(resolveInside(root, task.statusPath));
  const statusContent = updateStatus(
    statusBefore,
    chapterNumber(task.chapterId),
  );
  const writtenTask = persistedTask({ ...task, stage: "written" });
  const writeRecordPath = path.posix.join(task.directory, "07_写入记录.md");
  const afterHash = sha256(finalContent);
  const ticket = await prepareMutation(root, {
    kind: `finalize-task:${id}`,
    operations: [
      { kind: "replace", path: task.sourcePath, content: finalContent },
      { kind: "replace", path: task.statusPath, content: statusContent },
      {
        kind: "replace",
        path: path.posix.join(task.directory, "task.yaml"),
        content: serializeTask(writtenTask),
      },
      {
        kind: "create",
        path: writeRecordPath,
        content: `# 正式写入记录\n\n- 时间：${now()}\n- 正文：${task.sourcePath}\n- 状态：${task.statusPath}\n- 写入前哈希：${sha256(before)}\n- 写入后哈希：${afterHash}\n`,
      },
    ],
  });
  return {
    token: ticket.token,
    taskId: id,
    targetPath: task.sourcePath,
    statusPath: task.statusPath,
    beforeHash: sha256(before),
    afterHash,
    diff: textDiff(before, finalContent),
    expiresAt: ticket.expiresAt,
  };
}

/** 二次确认后通过持久化事务写入正文、状态、任务元数据和记录。 */
export async function commitWrite(
  root: string,
  id: string,
  token: string,
  explicitConfirmation: boolean,
): Promise<TaskRecord> {
  assert(
    explicitConfirmation,
    "WRITE_CONFIRMATION_REQUIRED",
    "正式写入需要再次明确确认",
  );
  const task = await getTask(root, id);
  try {
    await commitMutation(root, token, `finalize-task:${id}`);
  } catch (error) {
    if (error instanceof AppError && error.code === "MUTATION_CONFLICT") {
      const conflictPath = (error.details as { path?: string } | undefined)
        ?.path;
      if (conflictPath === task.sourcePath) {
        throw new AppError(
          "SOURCE_CHANGED",
          "预览后正文已发生变化，请重新预览",
          409,
        );
      }
      if (conflictPath === task.statusPath) {
        throw new AppError(
          "STATUS_CHANGED",
          "预览后章节状态表已发生变化，请重新预览",
          409,
        );
      }
    }
    if (!(error instanceof AppError)) {
      throw new AppError(
        "ATOMIC_WRITE_FAILED",
        "正式写入失败，事务已恢复或保留恢复现场",
        500,
        error instanceof Error ? error.message : error,
      );
    }
    throw error;
  }
  invalidateRepositoryReadModel(root);
  return getTask(root, id);
}

async function archiveTaskUnlocked(
  root: string,
  id: string,
): Promise<TaskRecord> {
  const task = await getTask(root, id);
  assert(
    task.stage === "written",
    "INVALID_STAGE",
    "只有已正式写入的任务可以归档",
  );
  const archiveRelative = path.posix.join("30_生产/archive", task.id);
  const destination = resolveInside(root, archiveRelative);
  await mkdir(path.dirname(destination), { recursive: true });
  const archived = persistedTask({
    ...task,
    stage: "archived",
    directory: archiveRelative,
  });
  const kind = `archive-task:${id}`;
  const ticket = await prepareMutation(root, {
    kind,
    operations: [
      {
        kind: "replace",
        path: path.posix.join(task.directory, "task.yaml"),
        content: serializeTask(archived),
      },
      {
        kind: "move-tree",
        path: task.directory,
        destinationPath: archiveRelative,
      },
    ],
  });
  await commitMutation(root, ticket.token, kind);
  return archived;
}

function guardedWrite<Args extends unknown[], Result>(
  operation: string,
  action: (root: string, ...args: Args) => Promise<Result>,
): (root: string, ...args: Args) => Promise<Result> {
  return (root, ...args) =>
    withRepositoryWriteGuard(root, operation, () => action(root, ...args));
}

export const createTask = guardedWrite("create-task", createTaskUnlocked);
export const buildContextPackage = guardedWrite(
  "build-context-package",
  buildContextPackageUnlocked,
);
export const importReview = guardedWrite("import-review", importReviewUnlocked);
export const recordDecisions = guardedWrite(
  "record-decisions",
  recordDecisionsUnlocked,
);
export const buildRevisionPackage = guardedWrite(
  "build-revision-package",
  buildRevisionPackageUnlocked,
);
export const buildCompactRevisionPackage = guardedWrite(
  "build-compact-revision-package",
  buildCompactRevisionPackageUnlocked,
);
export const buildCompactTextRevisionPackage = guardedWrite(
  "build-compact-text-revision-package",
  buildCompactTextRevisionPackageUnlocked,
);
export const importRevision = guardedWrite(
  "import-revision",
  importRevisionUnlocked,
);
export const saveHumanFinal = guardedWrite(
  "save-human-final",
  saveHumanFinalUnlocked,
);
export const confirmFinal = guardedWrite("confirm-final", confirmFinalUnlocked);
export const completeHumanFinal = guardedWrite(
  "complete-human-final",
  completeHumanFinalUnlocked,
);
export const rewindTaskStage = rewindTaskStageUnlocked;
export const archiveTask = archiveTaskUnlocked;
