import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface RepositoryFixture {
  root: string;
  volumeRoot: string;
  chapterRoot: string;
  chapterPath: string;
  statusPath: string;
  originalChapter: string;
  readChapter(): Promise<string>;
  readStatus(): Promise<string>;
  cleanup(): Promise<void>;
}

const STATUS_YAML = `schema_version: 2
volume:
  id: v01
  number: 1
  title: 测试卷
  status: active
  chapter_count: 3
canonical_root: 章节
status_authority: 本文件
status_ranges:
  - chapters: ch001-ch001
    status: final
    human_approved: true
    note: 作者确认终稿
  - chapters: ch002-ch003
    status: ai-revised
    human_approved: false
    review_gate: pending-human-review
    note: 等待人工验收
`;

export async function createRepositoryFixture(): Promise<RepositoryFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "evp-ai-novel-"));
  const volumeRoot = path.join(root, "40_正文", "卷", "v01");
  const chapterRoot = path.join(volumeRoot, "章节");
  const chapterPath = path.join(chapterRoot, "ch002.md");
  const statusPath = path.join(volumeRoot, "状态.yaml");
  const originalChapter = "# 第二章 待验收\n\n这是输入正文。\n";

  await Promise.all([
    mkdir(chapterRoot, { recursive: true }),
    mkdir(path.join(root, "10_圣经", "核心"), { recursive: true }),
    mkdir(path.join(root, "10_圣经", "人物"), { recursive: true }),
    mkdir(path.join(root, "20_规划", "卷", "v01"), { recursive: true }),
    mkdir(path.join(root, "30_生产", "active"), { recursive: true }),
    mkdir(path.join(root, "50_审稿", "逐章"), { recursive: true }),
    mkdir(path.join(root, "99_归档", "工作台回收站"), { recursive: true }),
  ]);

  await Promise.all([
    writeFile(statusPath, STATUS_YAML, "utf8"),
    writeFile(
      path.join(root, "10_圣经", "核心", "修订风格卡.md"),
      "# 修订风格卡\n\n准确、克制，保持第三人称限知视角。\n",
      "utf8",
    ),
    writeFile(
      path.join(chapterRoot, "ch001.md"),
      "# 第一章 终稿\n\n已确认。\n",
      "utf8",
    ),
    writeFile(chapterPath, originalChapter, "utf8"),
    writeFile(
      path.join(chapterRoot, "ch003.md"),
      "# 第三章 待验收\n\n下一章。\n",
      "utf8",
    ),
    writeFile(
      path.join(root, "10_圣经", "人物", "主角.md"),
      "# 主角\n",
      "utf8",
    ),
    writeFile(
      path.join(root, "20_规划", "卷", "v01", "卷纲.md"),
      "# 测试卷纲\n",
      "utf8",
    ),
    writeFile(
      path.join(root, "20_规划", "卷", "v01", "修订上下文卡.md"),
      "# 第一卷修订上下文卡\n\n保持当前人物状态和信息边界。\n",
      "utf8",
    ),
  ]);

  return {
    root,
    volumeRoot,
    chapterRoot,
    chapterPath,
    statusPath,
    originalChapter,
    readChapter: () => readFile(chapterPath, "utf8"),
    readStatus: () => readFile(statusPath, "utf8"),
    cleanup: () =>
      rm(root, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      }),
  };
}
