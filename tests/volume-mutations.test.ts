import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import yaml from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitVolumeMutation,
  getVolumeCreateDefaults,
  prepareVolumeArchive,
  prepareVolumeCreate,
  prepareVolumeRename,
  prepareVolumeRestore,
} from "../server/volume-mutations.js";
import type { VolumeStatusDocument } from "../server/repository-domain.js";
import type { RepositoryFixture } from "./helpers/repository-fixture.js";
import { createRepositoryFixture } from "./helpers/repository-fixture.js";

interface ConfirmablePreview {
  token: string;
  confirmationRequirements: string[];
}

const fixtures: RepositoryFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function fixture(): Promise<RepositoryFixture> {
  const value = await createRepositoryFixture();
  fixtures.push(value);
  return value;
}

async function commit(root: string, preview: ConfirmablePreview) {
  return commitVolumeMutation(
    root,
    preview.token,
    preview.confirmationRequirements,
  );
}

async function createEmptyVolume(
  repository: RepositoryFixture,
  title = "第二卷",
) {
  const preview = await prepareVolumeCreate(repository.root, { title });
  await commit(repository.root, preview);
  return preview;
}

async function readVolumeStatus(root: string, volumeId: string) {
  return yaml.load(
    await readFile(
      path.join(root, "40_正文", "卷", volumeId, "状态.yaml"),
      "utf8",
    ),
  ) as VolumeStatusDocument;
}

describe("新建卷与卷身份", () => {
  it("创建 planned 空卷，并在同一提交中建立状态表和空章节目录", async () => {
    const repository = await fixture();

    const preview = await prepareVolumeCreate(repository.root, {
      title: "新的旅程",
    });

    expect(preview).toMatchObject({
      kind: "create",
      volumeId: "v02",
      volumeNumber: 2,
      targetPath: "40_正文/卷/v02/状态.yaml",
      confirmationRequirements: ["confirm-volume-create"],
    });
    await expect(
      readFile(path.join(repository.root, "40_正文", "卷", "v02", "状态.yaml")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await commit(repository.root, preview);

    const status = await readVolumeStatus(repository.root, "v02");
    expect(status).toMatchObject({
      schema_version: 2,
      volume: {
        id: "v02",
        number: 2,
        title: "新的旅程",
        status: "planned",
        chapter_count: 0,
      },
      canonical_root: "章节",
      status_authority: "本文件",
      status_ranges: [],
    });
    expect(
      (
        await stat(path.join(repository.root, "40_正文", "卷", "v02", "章节"))
      ).isDirectory(),
    ).toBe(true);
  });

  it("卷 ID 和卷号按现存及归档历史最大值递增且不复用", async () => {
    const repository = await fixture();
    const created = await createEmptyVolume(repository, "短暂存在的第二卷");
    const archived = await prepareVolumeArchive(repository.root, {
      volumeId: created.volumeId,
      reason: "验证历史身份不复用",
    });
    await commit(repository.root, archived);

    const defaults = await getVolumeCreateDefaults(repository.root);
    expect(defaults).toMatchObject({ volumeId: "v03", volumeNumber: 3 });

    const next = await prepareVolumeCreate(repository.root, {
      title: "真正的第三卷",
    });
    expect(next).toMatchObject({ volumeId: "v03", volumeNumber: 3 });
  });
});

describe("卷名修改", () => {
  it("只替换状态 YAML 中的 title，不移动卷目录或改写卷纲与章节", async () => {
    const repository = await fixture();
    const chapterBefore = await repository.readChapter();
    const outlinePath = path.join(
      repository.root,
      "20_规划",
      "卷",
      "v01",
      "卷纲.md",
    );
    const outlineBefore = await readFile(outlinePath, "utf8");

    const preview = await prepareVolumeRename(repository.root, {
      volumeId: "v01",
      title: "长青新名",
    });

    expect(preview).toMatchObject({
      kind: "rename",
      volumeId: "v01",
      targetPath: "40_正文/卷/v01/状态.yaml",
      plannedChanges: ["更新 40_正文/卷/v01/状态.yaml 中的卷名"],
      confirmationRequirements: ["confirm-volume-rename"],
    });
    expect(preview.diff).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "added",
          value: expect.stringContaining("title: 长青新名"),
        }),
      ]),
    );

    await commit(repository.root, preview);

    const status = await readVolumeStatus(repository.root, "v01");
    expect(status.volume).toMatchObject({
      id: "v01",
      number: 1,
      title: "长青新名",
      chapter_count: 3,
    });
    expect(await repository.readChapter()).toBe(chapterBefore);
    expect(await readFile(outlinePath, "utf8")).toBe(outlineBefore);
    expect(repository.volumeRoot.endsWith(path.join("卷", "v01"))).toBe(true);
  });
});

describe("卷归档、引用影响与恢复", () => {
  it("空卷连同卷纲归档并可从 manifest 恢复", async () => {
    const repository = await fixture();
    await createEmptyVolume(repository);
    const outlinePath = path.join(
      repository.root,
      "20_规划",
      "卷",
      "v02",
      "卷纲.md",
    );
    await mkdir(path.dirname(outlinePath), { recursive: true });
    await writeFile(outlinePath, "# 第二卷卷纲\n", "utf8");

    const archive = await prepareVolumeArchive(repository.root, {
      volumeId: "v02",
      reason: "调整全书分卷",
    });
    expect(archive).toMatchObject({
      kind: "archive",
      volumeId: "v02",
      archiveId: expect.any(String),
      confirmationRequirements: ["confirm-volume-archive"],
    });
    const archiveId = archive.archiveId as string;
    expect(archive.plannedChanges).toEqual(
      expect.arrayContaining([
        expect.stringContaining("40_正文/卷/v02"),
        expect.stringContaining("20_规划/卷/v02"),
      ]),
    );

    await commit(repository.root, archive);
    await expect(
      readFile(path.join(repository.root, "40_正文", "卷", "v02", "状态.yaml")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(outlinePath)).rejects.toMatchObject({
      code: "ENOENT",
    });

    const manifestPath = path.join(
      repository.root,
      "99_归档",
      "工作台回收站",
      archiveId,
      "manifest.yaml",
    );
    const manifest = yaml.load(await readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(manifest).toMatchObject({
      asset_type: "volume",
      reason: "调整全书分卷",
      volume_state: {
        volume_id: "v02",
        volume_number: 2,
        title: "第二卷",
      },
      assets: expect.arrayContaining([
        expect.objectContaining({ original_path: "40_正文/卷/v02" }),
        expect.objectContaining({ original_path: "20_规划/卷/v02" }),
      ]),
      restorable: true,
    });

    const restore = await prepareVolumeRestore(repository.root, {
      archiveId,
    });
    await commit(repository.root, restore);

    expect((await readVolumeStatus(repository.root, "v02")).volume.title).toBe(
      "第二卷",
    );
    expect(await readFile(outlinePath, "utf8")).toBe("# 第二卷卷纲\n");
  });

  it("非空卷和仍有关联的活动生产任务均明确阻断归档", async () => {
    const repository = await fixture();
    await expect(
      prepareVolumeArchive(repository.root, {
        volumeId: "v01",
        reason: "不能归档非空卷",
      }),
    ).rejects.toMatchObject({ code: "VOLUME_NOT_EMPTY" });

    await createEmptyVolume(repository);
    const taskRoot = path.join(
      repository.root,
      "30_生产",
      "active",
      "v02-empty-task",
    );
    await mkdir(taskRoot, { recursive: true });
    await writeFile(
      path.join(taskRoot, "task.yaml"),
      yaml.dump({
        id: "v02-empty-task",
        volumeId: "v02",
        chapterId: "ch999",
        stage: "created",
        createdAt: "2026-07-18T00:00:00.000Z",
        updatedAt: "2026-07-18T00:00:00.000Z",
        directory: "30_生产/active/v02-empty-task",
        sourcePath: "40_正文/卷/v02/章节/ch999.md",
        statusPath: "40_正文/卷/v02/状态.yaml",
      }),
      "utf8",
    );

    await expect(
      prepareVolumeArchive(repository.root, {
        volumeId: "v02",
        reason: "活动任务仍存在",
      }),
    ).rejects.toMatchObject({ code: "VOLUME_HAS_ACTIVE_TASK" });
  });

  it("归档预览列出审稿和发布引用并要求单独确认", async () => {
    const repository = await fixture();
    await createEmptyVolume(repository);
    const reviewPath = path.join(
      repository.root,
      "50_审稿",
      "卷审",
      "v02",
      "终审.md",
    );
    const publicationPath = path.join(
      repository.root,
      "60_发布",
      "v02",
      "发布记录.md",
    );
    await mkdir(path.dirname(reviewPath), { recursive: true });
    await mkdir(path.dirname(publicationPath), { recursive: true });
    await writeFile(reviewPath, "引用：40_正文/卷/v02/状态.yaml\n", "utf8");
    await writeFile(publicationPath, "volume_id: v02\n", "utf8");

    const preview = await prepareVolumeArchive(repository.root, {
      volumeId: "v02",
      reason: "检查引用影响",
    });

    expect(preview.referenceImpacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "50_审稿/卷审/v02/终审.md",
          kind: "review",
        }),
        expect.objectContaining({
          path: "60_发布/v02/发布记录.md",
          kind: "publication",
        }),
      ]),
    );
    expect(preview.confirmationRequirements).toEqual([
      "confirm-volume-archive",
      "confirm-reference-impacts",
    ]);
  });

  it("恢复目标已存在时拒绝覆盖或自动改名", async () => {
    const repository = await fixture();
    await createEmptyVolume(repository);
    const archive = await prepareVolumeArchive(repository.root, {
      volumeId: "v02",
      reason: "制造恢复冲突",
    });
    await commit(repository.root, archive);
    const archiveId = archive.archiveId as string;

    const occupiedStatus = path.join(
      repository.root,
      "40_正文",
      "卷",
      "v02",
      "状态.yaml",
    );
    await mkdir(path.dirname(occupiedStatus), { recursive: true });
    await writeFile(occupiedStatus, "占用目标，不得覆盖\n", "utf8");

    await expect(
      prepareVolumeRestore(repository.root, { archiveId }),
    ).rejects.toMatchObject({ code: "RESTORE_TARGET_OCCUPIED" });
    expect(await readFile(occupiedStatus, "utf8")).toBe("占用目标，不得覆盖\n");
  });

  it("恢复拒绝大小写或 Unicode 规范化后的等价目录名", async () => {
    const repository = await fixture();
    await createEmptyVolume(repository);
    const archive = await prepareVolumeArchive(repository.root, {
      volumeId: "v02",
      reason: "制造规范化冲突",
    });
    await commit(repository.root, archive);
    await mkdir(path.join(repository.root, "40_正文", "卷", "ｖ０２"));

    await expect(
      prepareVolumeRestore(repository.root, {
        archiveId: archive.archiveId as string,
      }),
    ).rejects.toMatchObject({ code: "RESTORE_TARGET_OCCUPIED" });
  });

  it("卷目录树包含符号链接或 junction 时拒绝归档", async () => {
    const repository = await fixture();
    await createEmptyVolume(repository);
    const outside = await mkdtemp(
      path.join(tmpdir(), "novel-volume-outside-"),
    );
    const link = path.join(repository.root, "40_正文", "卷", "v02", "越界链接");
    try {
      await symlink(
        outside,
        link,
        process.platform === "win32" ? "junction" : "dir",
      );
      await expect(
        prepareVolumeArchive(repository.root, {
          volumeId: "v02",
          reason: "不得移动越界链接",
        }),
      ).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE_TREE" });
    } finally {
      await rm(link, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
