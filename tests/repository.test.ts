import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import type { RepositoryFixture } from "./helpers/repository-fixture.js";
import { createRepositoryFixture } from "./helpers/repository-fixture.js";
import { resolveInside } from "../server/files.js";
import {
  invalidateRepositoryReadModel,
  readChapterDetail,
  readDocument,
  readRepositoryIndex,
  readVolumeDetail,
  readVolumes,
  searchDocuments,
} from "../server/repository.js";

const fixtures: RepositoryFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function createEmptyVolume(
  root: string,
  id: string,
  number: number,
  title: string,
): Promise<void> {
  const volumeRoot = path.join(root, "40_正文", "卷", id);
  await mkdir(path.join(volumeRoot, "章节"), { recursive: true });
  await writeFile(
    path.join(volumeRoot, "状态.yaml"),
    `schema_version: 2
volume:
  id: ${id}
  number: ${number}
  title: ${title}
  status: planned
  chapter_count: 0
canonical_root: 章节
status_authority: 本文件
status_ranges: []
`,
    "utf8",
  );
}

async function createVolumeWithChapters(
  root: string,
  id: string,
  number: number,
  title: string,
  chapterNumbers: number[],
): Promise<void> {
  const volumeRoot = path.join(root, "40_正文", "卷", id);
  const chapterRoot = path.join(volumeRoot, "章节");
  await mkdir(chapterRoot, { recursive: true });
  const first = Math.min(...chapterNumbers);
  const last = Math.max(...chapterNumbers);
  await Promise.all([
    writeFile(
      path.join(volumeRoot, "状态.yaml"),
      `schema_version: 2
volume:
  id: ${id}
  number: ${number}
  title: ${title}
  status: active
  chapter_count: ${chapterNumbers.length}
canonical_root: 章节
status_authority: 本文件
status_ranges:
  - chapters: ch${String(first).padStart(3, "0")}-ch${String(last).padStart(3, "0")}
    status: draft
    human_approved: false
`,
      "utf8",
    ),
    ...chapterNumbers.map((chapterNumber) => {
      const chapterId = `ch${String(chapterNumber).padStart(3, "0")}`;
      return writeFile(
        path.join(chapterRoot, `${chapterId}.md`),
        `# 第${chapterNumber}章\n\n正文。\n`,
        "utf8",
      );
    }),
  ]);
}

describe("章节状态范围", () => {
  it("将 YAML 范围映射到各章并正确汇总", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);

    const [volume] = await readVolumes(fixture.root);

    expect(volume).toMatchObject({
      id: "v01",
      chapterCount: 3,
      finalCount: 1,
      aiRevisedCount: 2,
    });
    expect(
      volume?.chapters.map((chapter) => [
        chapter.id,
        chapter.status,
        chapter.humanApproved,
      ]),
    ).toEqual([
      ["ch001", "final", true],
      ["ch002", "ai-revised", false],
      ["ch003", "ai-revised", false],
    ]);
  });

  it("健康夹具通过 schema、H1 和精确覆盖检查", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);

    const index = await readRepositoryIndex(fixture.root);

    expect(index.health).toEqual({ healthy: true, issues: [] });
  });

  it("修改 YAML 卷名不会要求移动纯 ID 目录", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const status = await readFile(fixture.statusPath, "utf8");
    await writeFile(
      fixture.statusPath,
      status.replace("title: 测试卷", "title: 改名后的卷 / 仍在 v01"),
      "utf8",
    );

    const index = await readRepositoryIndex(fixture.root);

    expect(index.health).toEqual({ healthy: true, issues: [] });
    expect(index.volumes[0]).toMatchObject({
      id: "v01",
      number: 1,
      title: "改名后的卷 / 仍在 v01",
      lifecycleStatus: "active",
    });
  });

  it("按 YAML 卷号排序并诊断重复卷号", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const status = await readFile(fixture.statusPath, "utf8");
    await writeFile(
      fixture.statusPath,
      status.replace("number: 1", "number: 2"),
      "utf8",
    );
    await createEmptyVolume(fixture.root, "v02", 1, "前置卷");

    const sorted = await readRepositoryIndex(fixture.root);
    expect(sorted.volumes.map(({ id }) => id)).toEqual(["v02", "v01"]);

    await createEmptyVolume(fixture.root, "v03", 1, "重复卷号");
    const duplicated = await readRepositoryIndex(fixture.root);
    expect(duplicated.health.issues).toContainEqual(
      expect.objectContaining({ code: "DUPLICATE_VOLUME_NUMBER" }),
    );
  });

  it("按数值章号排序四位章 ID，并为相同卷号提供稳定顺序", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    await createVolumeWithChapters(
      fixture.root,
      "v02",
      2,
      "四位章卷",
      [999, 1000],
    );
    await createEmptyVolume(fixture.root, "v03", 2, "同号卷");

    const index = await readRepositoryIndex(fixture.root);

    expect(index.volumes.map((volume) => volume.id)).toEqual([
      "v01",
      "v02",
      "v03",
    ]);
    expect(index.volumes[1]?.chapters.map((chapter) => chapter.id)).toEqual([
      "ch999",
      "ch1000",
    ]);
  });

  it("章节详情提供跨卷前后导航和完整摘要元数据", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    await createVolumeWithChapters(fixture.root, "v02", 2, "第二卷", [4, 5]);

    const first = await readChapterDetail(fixture.root, "v01", "ch001");
    const boundary = await readChapterDetail(fixture.root, "v01", "ch003");
    const last = await readChapterDetail(fixture.root, "v02", "ch005");

    expect(first.previous).toBeUndefined();
    expect(first).toMatchObject({
      id: "ch001",
      number: 1,
      chapterId: "ch001",
      volume: { id: "v01", number: 1, title: "测试卷" },
      wordCount: expect.any(Number),
      modifiedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(boundary.next).toEqual({
      volumeId: "v02",
      volumeNumber: 2,
      chapterId: "ch004",
      chapterNumber: 4,
      title: "第4章",
    });
    expect(last.previous).toMatchObject({ chapterId: "ch004" });
    expect(last.next).toBeUndefined();
  });

  it("卷详情聚合统计并只公开精确卷纲和安全的显式相关记录", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const status = await readFile(fixture.statusPath, "utf8");
    await Promise.all([
      mkdir(path.join(fixture.root, "20_规划", "卷", "v01"), {
        recursive: true,
      }),
      writeFile(
        fixture.statusPath,
        `${status}historical_review_records:\n  - ../../../50_审稿/逐章/v01/索引.md\n  - ../../../../仓库外.md\n`,
        "utf8",
      ),
      mkdir(path.join(fixture.root, "50_审稿", "逐章", "v01"), {
        recursive: true,
      }),
    ]);
    await Promise.all([
      writeFile(
        path.join(fixture.root, "20_规划", "卷", "v01", "卷纲.md"),
        "# 卷纲\n",
        "utf8",
      ),
      writeFile(
        path.join(fixture.root, "50_审稿", "逐章", "v01", "索引.md"),
        "# 审稿索引\n",
        "utf8",
      ),
    ]);

    const detail = await readVolumeDetail(fixture.root, "v01", "ch002");

    expect(detail).toMatchObject({
      id: "v01",
      chapterCount: 3,
      totalWordCount: expect.any(Number),
      statusCounts: { final: 1, "ai-revised": 2 },
      firstChapter: { chapterId: "ch001" },
      lastChapter: { chapterId: "ch003" },
      currentChapterId: "ch002",
      outline: {
        path: "20_规划/卷/v01/卷纲.md",
        title: "测试卷卷纲",
      },
      relatedRecords: [
        {
          kind: "review",
          path: "50_审稿/逐章/v01/索引.md",
          title: "索引",
        },
      ],
    });
    expect(detail.healthIssues).toContainEqual(
      expect.objectContaining({ code: "INVALID_RELATED_RECORD_PATH" }),
    );
    expect(
      detail.relatedRecords.some((record) => record.path.includes("..")),
    ).toBe(false);
  });

  it("未知卷与卷章不匹配分别返回稳定的 404", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);

    await expect(readVolumeDetail(fixture.root, "v99")).rejects.toMatchObject({
      code: "VOLUME_NOT_FOUND",
      status: 404,
    });
    await expect(
      readChapterDetail(fixture.root, "v99", "ch002"),
    ).rejects.toMatchObject({ code: "CHAPTER_NOT_FOUND", status: 404 });
  });

  it("500 章索引保持完整数值顺序并在合理时间内完成", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    await createVolumeWithChapters(
      fixture.root,
      "v02",
      2,
      "规模测试卷",
      Array.from({ length: 497 }, (_, index) => index + 4),
    );
    invalidateRepositoryReadModel(fixture.root);

    const startedAt = performance.now();
    const index = await readRepositoryIndex(fixture.root);
    const elapsed = performance.now() - startedAt;

    expect(index.volumes.flatMap((volume) => volume.chapters)).toHaveLength(
      500,
    );
    expect(index.volumes[1]?.chapters.at(-1)?.id).toBe("ch500");
    expect(elapsed).toBeLessThan(5_000);
  }, 20_000);

  it("状态范围遗漏正文时返回阻断诊断", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    await writeFile(
      fixture.statusPath,
      `schema_version: 2
volume:
  id: v01
  number: 1
  title: 测试卷
  status: active
  chapter_count: 3
canonical_root: 章节
status_authority: 本文件
status_ranges:
  - chapters: ch001-ch002
    status: ai-revised
    human_approved: false
`,
      "utf8",
    );

    const index = await readRepositoryIndex(fixture.root);

    expect(index.health.healthy).toBe(false);
    expect(index.health.issues).toContainEqual(
      expect.objectContaining({
        code: "UNCOVERED_CHAPTER",
        chapterId: "ch003",
      }),
    );
  });

  it("跨卷重复章 ID 不会被静默覆盖", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const volumeRoot = path.join(fixture.root, "40_正文", "卷", "v02");
    await mkdir(path.join(volumeRoot, "章节"), { recursive: true });
    await writeFile(
      path.join(volumeRoot, "状态.yaml"),
      `schema_version: 2
volume:
  id: v02
  number: 2
  title: 第二卷
  status: active
  chapter_count: 1
canonical_root: 章节
status_authority: 本文件
status_ranges:
  - chapters: ch001
    status: draft
    human_approved: false
`,
      "utf8",
    );
    await writeFile(
      path.join(volumeRoot, "章节", "ch001.md"),
      "# 重复章节\n\n正文。\n",
      "utf8",
    );

    const index = await readRepositoryIndex(fixture.root);

    expect(index.health.issues).toContainEqual(
      expect.objectContaining({
        code: "DUPLICATE_CHAPTER_ID",
        chapterId: "ch001",
      }),
    );
  });

  it("孤儿卷目录与缺失章节根目录均形成阻断诊断", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    await mkdir(path.join(fixture.root, "40_正文", "卷", "v02"), {
      recursive: true,
    });
    await rm(path.join(fixture.root, "40_正文", "卷", "v01", "章节"), {
      recursive: true,
    });

    const index = await readRepositoryIndex(fixture.root);

    expect(index.health.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "ORPHAN_VOLUME_DIRECTORY",
          path: "40_正文/卷/v02",
        }),
        expect.objectContaining({
          code: "INVALID_CANONICAL_ROOT",
          path: "40_正文/卷/v01/章节",
        }),
      ]),
    );
  });

  it("没有当前正文卷的规划卷目录形成阻断诊断", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    await mkdir(path.join(fixture.root, "20_规划", "卷", "v02"), {
      recursive: true,
    });

    const index = await readRepositoryIndex(fixture.root);

    expect(index.health.issues).toContainEqual(
      expect.objectContaining({
        code: "ORPHAN_PLANNING_VOLUME_DIRECTORY",
        path: "20_规划/卷/v02",
      }),
    );
  });

  it("章节摘要缓存随外部文件变化失效，详情只读取目标正文", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    invalidateRepositoryReadModel();
    await readVolumes(fixture.root);
    await writeFile(
      fixture.chapterPath,
      "# 第二章 外部修改\n\n这是长度不同的新正文。\n",
      "utf8",
    );

    const volumes = await readVolumes(fixture.root);
    const detail = await readChapterDetail(fixture.root, "v01", "ch002");

    expect(volumes[0]?.chapters[1]?.title).toBe("第二章 外部修改");
    expect(detail.content).toContain("长度不同的新正文");
  });
});

describe("文档索引", () => {
  it("空查询返回按权威等级排序的文档索引", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);

    const documents = await searchDocuments(fixture.root, "");

    expect(documents.length).toBeGreaterThan(0);
    expect(documents[0]).toMatchObject({ authority: "canonical" });
    expect(documents.some((item) => item.authority === "bible")).toBe(true);
  });
});

describe("仓库路径边界", () => {
  it("章节根目录是仓库外 junction 时索引保持阻断", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const outside = await mkdtemp(
      path.join(tmpdir(), "novel-chapters-outside-"),
    );
    const chapterRoot = path.join(fixture.root, "40_正文", "卷", "v01", "章节");

    try {
      await rm(chapterRoot, { recursive: true, force: true });
      await writeFile(path.join(outside, "ch001.md"), "# 仓库外章节\n", "utf8");
      await symlink(
        outside,
        chapterRoot,
        process.platform === "win32" ? "junction" : "dir",
      );

      const index = await readRepositoryIndex(fixture.root);

      expect(index.health.issues).toContainEqual(
        expect.objectContaining({
          code: "INVALID_CANONICAL_ROOT",
          path: "40_正文/卷/v01/章节",
        }),
      );
      expect(index.volumes[0]?.chapters).toHaveLength(0);
    } finally {
      await rm(chapterRoot, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it.each(["../仓库外.md", "../../secret.txt"])(
    "拒绝目录穿越：%s",
    async (unsafePath) => {
      const fixture = await createRepositoryFixture();
      fixtures.push(fixture);

      expect(() => resolveInside(fixture.root, unsafePath)).toThrowError(
        expect.objectContaining({ code: "PATH_OUTSIDE_REPOSITORY" }),
      );
      await expect(
        readDocument(fixture.root, unsafePath),
      ).rejects.toMatchObject({ code: "PATH_OUTSIDE_REPOSITORY" });
    },
  );

  it("拒绝仓库外绝对路径", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const outside = path.resolve(fixture.root, "..", "仓库外.md");

    expect(() => resolveInside(fixture.root, outside)).toThrowError(
      expect.objectContaining({ code: "PATH_OUTSIDE_REPOSITORY" }),
    );
  });

  it("拒绝通过仓库内符号链接或 junction 读取仓库外文件", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const outside = await mkdtemp(path.join(tmpdir(), "novel-outside-"));
    await mkdir(path.join(fixture.root, "70_素材"), { recursive: true });
    await writeFile(path.join(outside, "secret.md"), "不得读取", "utf8");
    const link = path.join(fixture.root, "70_素材", "越界链接");

    try {
      await symlink(
        outside,
        link,
        process.platform === "win32" ? "junction" : "dir",
      );
      expect(() =>
        resolveInside(fixture.root, "70_素材/越界链接/secret.md"),
      ).toThrowError(
        expect.objectContaining({ code: "PATH_OUTSIDE_REPOSITORY" }),
      );
      await expect(
        readDocument(fixture.root, "70_素材/越界链接/secret.md"),
      ).rejects.toMatchObject({ code: "PATH_OUTSIDE_REPOSITORY" });
    } finally {
      await rm(link, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
