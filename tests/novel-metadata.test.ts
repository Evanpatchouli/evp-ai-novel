import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitNovelMetadataMutation,
  prepareNovelMetadata,
  readNovelMetadata,
} from "../server/novel-metadata.js";
import {
  MAX_NOVEL_COVER_BYTES,
  NovelMetadataSchema,
} from "../server/repository-domain.js";
import type { RepositoryFixture } from "./helpers/repository-fixture.js";
import { createRepositoryFixture } from "./helpers/repository-fixture.js";

const fixtures: RepositoryFixture[] = [];
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function fixture(): Promise<RepositoryFixture> {
  const repository = await createRepositoryFixture();
  fixtures.push(repository);
  return repository;
}

async function commit(
  repository: RepositoryFixture,
  preview: { token: string; confirmationRequirements: string[] },
) {
  return commitNovelMetadataMutation(
    repository.root,
    preview.token,
    preview.confirmationRequirements,
  );
}

describe("可选小说元数据", () => {
  it("缺少小说 YAML 时兼容读取且绝不隐式落盘", async () => {
    const repository = await fixture();
    const metadataPath = path.join(repository.root, "00_项目", "小说.yaml");

    const detail = await readNovelMetadata(repository.root);

    expect(detail).toMatchObject({
      exists: false,
      path: "00_项目/小说.yaml",
      metadata: {
        schema_version: 1,
        novel: { id: "novel", title: "示例小说" },
      },
    });
    expect(detail.sourceHash).toBeUndefined();
    await expect(access(metadataPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("通过结构化输入创建规范 YAML，预览展示完整新内容", async () => {
    const repository = await fixture();
    await mkdir(path.join(repository.root, "00_项目"), { recursive: true });
    const input = {
      title: "示例小说",
      author: "测试作者",
      description: "一部虚构长篇小说。",
      currentVolume: "v01",
      currentChapter: "ch002",
      coverUpload: {
        name: "本地选择的封面.png",
        mimeType: "image/png",
        contentBase64: PNG_BASE64,
      },
    };

    const preview = await prepareNovelMetadata(repository.root, input);

    expect(preview).toMatchObject({
      kind: "create",
      targetPath: "00_项目/小说.yaml",
      confirmationRequirements: ["confirm-novel-metadata-create"],
    });
    expect(
      preview.diff.some((change) => change.value.includes("示例小说")),
    ).toBe(true);
    await commit(repository, preview);

    const raw = await readFile(
      path.join(repository.root, "00_项目", "小说.yaml"),
      "utf8",
    );
    expect(NovelMetadataSchema.parse(yaml.load(raw))).toEqual({
      schema_version: 1,
      novel: {
        id: "novel",
        title: input.title,
        author: input.author,
        description: input.description,
        cover: "70_素材/封面.png",
        current_volume: "v01",
        current_chapter: "ch002",
      },
    });
    expect(
      await readFile(path.join(repository.root, "70_素材", "封面.png")),
    ).toEqual(Buffer.from(PNG_BASE64, "base64"));
  });

  it("拒绝伪装成 PNG 的封面，并原子替换固定封面文件", async () => {
    const repository = await fixture();
    await expect(
      prepareNovelMetadata(repository.root, {
        title: "示例小说",
        author: "测试作者",
        description: "测试",
        coverUpload: {
          name: "伪装.png",
          mimeType: "image/png",
          contentBase64: Buffer.from("not a png").toString("base64"),
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_NOVEL_COVER" });
    const oversized = Buffer.alloc(MAX_NOVEL_COVER_BYTES + 1);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(oversized);
    await expect(
      prepareNovelMetadata(repository.root, {
        title: "示例小说",
        author: "测试作者",
        description: "测试",
        coverUpload: {
          name: "过大封面.png",
          mimeType: "image/png",
          contentBase64: oversized.toString("base64"),
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_NOVEL_COVER" });

    await mkdir(path.join(repository.root, "00_项目"), { recursive: true });
    const created = await prepareNovelMetadata(repository.root, {
      title: "示例小说",
      author: "测试作者",
      description: "初始封面",
      coverUpload: {
        name: "first.png",
        mimeType: "image/png",
        contentBase64: PNG_BASE64,
      },
    });
    await commit(repository, created);
    const current = await readNovelMetadata(repository.root);
    const replacement = `${PNG_BASE64.slice(0, -4)}AAAA`;
    const preview = await prepareNovelMetadata(repository.root, {
      title: "示例小说",
      author: "测试作者",
      description: "替换封面",
      expectedHash: current.sourceHash,
      coverUpload: {
        name: "second.png",
        mimeType: "image/png",
        contentBase64: replacement,
      },
    });
    expect(preview.plannedChanges).toContain("替换 70_素材/封面.png");
    await commit(repository, preview);
    expect(
      await readFile(path.join(repository.root, "70_素材", "封面.png")),
    ).toEqual(Buffer.from(replacement, "base64"));
  });

  it("拒绝非法结构、不存在的当前卷章和预览后外部修改", async () => {
    const repository = await fixture();
    await expect(
      prepareNovelMetadata(repository.root, {
        title: "示例小说",
        author: "测试作者",
        description: "测试",
        currentVolume: "v99",
        currentChapter: "ch999",
      }),
    ).rejects.toMatchObject({ code: "INVALID_NOVEL_LOCATION" });

    await mkdir(path.join(repository.root, "00_项目"), { recursive: true });
    const created = await prepareNovelMetadata(repository.root, {
      title: "示例小说",
      author: "测试作者",
      description: "初始版本",
    });
    await commit(repository, created);
    const current = await readNovelMetadata(repository.root);
    const preview = await prepareNovelMetadata(repository.root, {
      title: "示例小说",
      author: "测试作者",
      description: "工作台新版本",
      expectedHash: current.sourceHash,
    });
    const metadataPath = path.join(repository.root, "00_项目", "小说.yaml");
    await writeFile(
      metadataPath,
      (await readFile(metadataPath, "utf8")) + "# 外部编辑器备注\n",
      "utf8",
    );

    await expect(commit(repository, preview)).rejects.toMatchObject({
      code: "MUTATION_CONFLICT",
    });
    expect(await readFile(metadataPath, "utf8")).toContain("外部编辑器");
  });

  it("编辑时保留已有小说的自定义 ID", async () => {
    const repository = await fixture();
    await mkdir(path.join(repository.root, "00_项目"), { recursive: true });
    const metadataPath = path.join(repository.root, "00_项目", "小说.yaml");
    await writeFile(metadataPath, `schema_version: 1
novel:
  id: another-story
  title: 原书名
  author: 测试作者
  description: 简介
`, "utf8");
    const current = await readNovelMetadata(repository.root);
    const preview = await prepareNovelMetadata(repository.root, {
      title: "新书名", author: "测试作者", description: "简介", expectedHash: current.sourceHash,
    });
    await commit(repository, preview);
    expect((await readNovelMetadata(repository.root)).metadata.novel).toMatchObject({
      id: "another-story", title: "新书名",
    });
  });

  it("已存在 YAML 的 expectedHash 必须与当前内容一致", async () => {
    const repository = await fixture();
    await mkdir(path.join(repository.root, "00_项目"), { recursive: true });
    await writeFile(
      path.join(repository.root, "00_项目", "小说.yaml"),
      `schema_version: 1
novel:
  id: novel
  title: 示例小说
  author: 测试作者
  description: 现有版本
`,
      "utf8",
    );

    await expect(
      prepareNovelMetadata(repository.root, {
        title: "示例小说",
        author: "测试作者",
        description: "新版本",
        expectedHash: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "NOVEL_METADATA_CONFLICT" });
  });
});
