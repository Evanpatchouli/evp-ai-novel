import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitChapterMutation,
  prepareChapterArchive,
  prepareChapterCreate,
  prepareChapterEdit,
  prepareChapterRestore,
} from "../server/chapter-mutations.js";
import type { ChapterMutationPreview } from "../shared/contracts.js";
import type { VolumeStatusDocument } from "../server/repository-domain.js";
import type { RepositoryFixture } from "./helpers/repository-fixture.js";
import { createRepositoryFixture } from "./helpers/repository-fixture.js";

const fixtures: RepositoryFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function fixture(): Promise<RepositoryFixture> {
  const value = await createRepositoryFixture();
  fixtures.push(value);
  return value;
}

async function commit(root: string, preview: ChapterMutationPreview) {
  return commitChapterMutation(
    root,
    preview.token,
    preview.confirmationRequirements,
  );
}

async function status(repository: RepositoryFixture) {
  return yaml.load(
    await readFile(repository.statusPath, "utf8"),
  ) as VolumeStatusDocument;
}

describe("章节正文校验与编辑", () => {
  it("非终稿先预览完整差异，明确提交后才以 UTF-8 无 BOM 写入", async () => {
    const repository = await fixture();
    const content = "# 第二章 中文修订\n\n长青 walked 2 steps。\n";

    const preview = await prepareChapterEdit(repository.root, {
      volumeId: "v01",
      chapterId: "ch002",
      content,
    });

    expect(await repository.readChapter()).toBe(repository.originalChapter);
    expect(preview.afterWordCount).toBe(5);
    expect(preview.targetPath).toBe("40_正文/卷/v01/章节/ch002.md");
    expect(preview.diff).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "added",
          value: expect.stringContaining("第二章 中文修订"),
        }),
      ]),
    );

    await commit(repository.root, preview);

    const bytes = await readFile(repository.chapterPath);
    expect(bytes.subarray(0, 3)).not.toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(bytes.toString("utf8")).toBe(content);
  });

  it.each([
    ["缺少 H1", "正文没有标题\n", "INVALID_CHAPTER_CONTENT"],
    ["多个 H1", "# 标题\n\n# 第二个标题\n", "INVALID_CHAPTER_CONTENT"],
    ["UTF-8 BOM", "\uFEFF# 标题\n\n正文\n", "CHAPTER_BOM_NOT_ALLOWED"],
  ])("拒绝%s", async (_label, content, code) => {
    const repository = await fixture();

    await expect(
      prepareChapterEdit(repository.root, {
        volumeId: "v01",
        chapterId: "ch002",
        content,
      }),
    ).rejects.toMatchObject({ code });
    expect(await repository.readChapter()).toBe(repository.originalChapter);
  });

  it("终稿不能通过普通章节编辑绕过修订流程", async () => {
    const repository = await fixture();

    await expect(
      prepareChapterEdit(repository.root, {
        volumeId: "v01",
        chapterId: "ch001",
        content: "# 第一章 被直接改写\n\n不允许。\n",
      }),
    ).rejects.toMatchObject({ code: "FINAL_CHAPTER_READ_ONLY" });
  });

  it("预览后正文被外部修改时拒绝覆盖", async () => {
    const repository = await fixture();
    const preview = await prepareChapterEdit(repository.root, {
      volumeId: "v01",
      chapterId: "ch002",
      content: "# 第二章 新稿\n\n预览内容。\n",
    });
    await writeFile(
      repository.chapterPath,
      "# 第二章 外部稿\n\n外部修改。\n",
      "utf8",
    );

    await expect(commit(repository.root, preview)).rejects.toMatchObject({
      code: "MUTATION_CONFLICT",
    });
    expect(await repository.readChapter()).toContain("外部修改");
  });
});

describe("卷末创建章节", () => {
  it("使用全书历史最大编号加一，并联动章节文件和状态表", async () => {
    const repository = await fixture();
    const archivedManifest = path.join(
      repository.root,
      "99_归档",
      "工作台回收站",
      "old-ch010",
      "manifest.yaml",
    );
    await mkdir(path.dirname(archivedManifest), { recursive: true });
    await writeFile(
      archivedManifest,
      yaml.dump({
        schema_version: 1,
        archived_at: "2026-07-18T00:00:00.000Z",
        asset_type: "chapter",
        original_path: "40_正文/卷/v02/章节/ch010.md",
        archive_path:
          "99_归档/工作台回收站/old-ch010/40_正文/卷/v02/章节/ch010.md",
        reason: "旧章",
        before_hash: "a".repeat(64),
        affected_references: [],
        restorable: true,
        chapter_state: {
          volume_id: "v02",
          chapter_id: "ch010",
          status: "draft",
          human_approved: false,
        },
      }),
      "utf8",
    );

    const preview = await prepareChapterCreate(repository.root, {
      volumeId: "v01",
      content: "# 第十一章 新章\n\n中文正文。\n",
    });
    expect(preview.chapterId).toBe("ch011");
    await commit(repository.root, preview);

    expect(
      await readFile(
        path.join(repository.root, "40_正文", "卷", "v01", "章节", "ch011.md"),
        "utf8",
      ),
    ).toBe("# 第十一章 新章\n\n中文正文。\n");
    const updated = await status(repository);
    expect(updated.volume.chapter_count).toBe(4);
    expect(updated.status_ranges).toContainEqual(
      expect.objectContaining({
        chapters: "ch011",
        status: "draft",
        human_approved: false,
      }),
    );
  });

  it("预览后状态表变化时整项创建失败", async () => {
    const repository = await fixture();
    const preview = await prepareChapterCreate(repository.root, {
      volumeId: "v01",
      content: "# 第四章 新章\n\n正文。\n",
    });
    await writeFile(
      repository.statusPath,
      `${await readFile(repository.statusPath, "utf8")}\n# 外部修改\n`,
      "utf8",
    );

    await expect(commit(repository.root, preview)).rejects.toMatchObject({
      code: "MUTATION_CONFLICT",
    });
    await expect(
      readFile(
        path.join(repository.root, "40_正文", "卷", "v01", "章节", "ch004.md"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("章节归档与恢复", () => {
  it("归档非终稿并从 manifest 无损恢复正文和状态", async () => {
    const repository = await fixture();
    const archive = await prepareChapterArchive(repository.root, {
      volumeId: "v01",
      chapterId: "ch002",
      reason: "章节重写前暂存",
    });
    expect(await repository.readChapter()).toBe(repository.originalChapter);
    await commit(repository.root, archive);

    await expect(repository.readChapter()).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await status(repository)).volume.chapter_count).toBe(2);
    const manifest = yaml.load(
      await readFile(
        path.join(
          repository.root,
          "99_归档",
          "工作台回收站",
          archive.archiveId!,
          "manifest.yaml",
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      asset_type: "chapter",
      before_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      chapter_state: {
        volume_id: "v01",
        chapter_id: "ch002",
        status: "ai-revised",
        human_approved: false,
      },
    });

    const restore = await prepareChapterRestore(repository.root, {
      archiveId: archive.archiveId!,
    });
    await commit(repository.root, restore);

    expect(await repository.readChapter()).toBe(repository.originalChapter);
    expect((await status(repository)).volume.chapter_count).toBe(3);
    expect((await status(repository)).status_ranges).toContainEqual(
      expect.objectContaining({
        chapters: "ch002-ch003",
        status: "ai-revised",
        human_approved: false,
      }),
    );
  });

  it("终稿不能通过普通归档绕过终稿门禁", async () => {
    const repository = await fixture();

    await expect(
      prepareChapterArchive(repository.root, {
        volumeId: "v01",
        chapterId: "ch001",
        reason: "不允许",
      }),
    ).rejects.toMatchObject({ code: "FINAL_CHAPTER_READ_ONLY" });
  });

  it("恢复目标已被占用时拒绝覆盖", async () => {
    const repository = await fixture();
    const archive = await prepareChapterArchive(repository.root, {
      volumeId: "v01",
      chapterId: "ch002",
      reason: "测试恢复冲突",
    });
    await commit(repository.root, archive);
    await writeFile(
      repository.chapterPath,
      "# 第二章 占位\n\n不得覆盖。\n",
      "utf8",
    );

    await expect(
      prepareChapterRestore(repository.root, {
        archiveId: archive.archiveId!,
      }),
    ).rejects.toMatchObject({ code: "RESTORE_TARGET_OCCUPIED" });
    expect(await repository.readChapter()).toContain("不得覆盖");
  });

  it("恢复目标存在大小写或 Unicode 规范化冲突时拒绝自动改名", async () => {
    const repository = await fixture();
    const archive = await prepareChapterArchive(repository.root, {
      volumeId: "v01",
      chapterId: "ch002",
      reason: "测试规范化冲突",
    });
    await commit(repository.root, archive);
    const normalizedConflict = path.join(
      repository.root,
      "40_正文",
      "卷",
      "v01",
      "章节",
      "ｃｈ002.md",
    );
    await writeFile(
      normalizedConflict,
      "# 冲突占位\n\n不得自动改名。\n",
      "utf8",
    );

    await expect(
      prepareChapterRestore(repository.root, {
        archiveId: archive.archiveId!,
      }),
    ).rejects.toMatchObject({ code: "RESTORE_TARGET_OCCUPIED" });
    expect(await readFile(normalizedConflict, "utf8")).toContain(
      "不得自动改名",
    );
  });

  it("归档正文被外部篡改时拒绝猜测恢复", async () => {
    const repository = await fixture();
    const archive = await prepareChapterArchive(repository.root, {
      volumeId: "v01",
      chapterId: "ch002",
      reason: "测试归档哈希",
    });
    await commit(repository.root, archive);
    const archiveRoot = path.join(
      repository.root,
      "99_归档",
      "工作台回收站",
      archive.archiveId!,
    );
    const manifest = yaml.load(
      await readFile(path.join(archiveRoot, "manifest.yaml"), "utf8"),
    ) as { archive_path: string };
    await writeFile(
      path.join(repository.root, ...manifest.archive_path.split("/")),
      "# 第二章 篡改稿\n\n不能恢复。\n",
      "utf8",
    );

    await expect(
      prepareChapterRestore(repository.root, {
        archiveId: archive.archiveId!,
      }),
    ).rejects.toMatchObject({ code: "ARCHIVE_HASH_MISMATCH" });
  });
});
