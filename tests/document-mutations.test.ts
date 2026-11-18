import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitDocumentMutation,
  listDocumentArchives,
  prepareDocumentArchive,
  prepareDocumentCreate,
  prepareDocumentEdit,
  prepareDocumentRestore,
} from "../server/document-mutations.js";
import { sha256 } from "../server/files.js";
import type { RepositoryFixture } from "./helpers/repository-fixture.js";
import { createRepositoryFixture } from "./helpers/repository-fixture.js";

const fixtures: RepositoryFixture[] = [];
const outsideDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
  await Promise.all(
    outsideDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<RepositoryFixture> {
  const repository = await createRepositoryFixture();
  fixtures.push(repository);
  return repository;
}

async function seed(
  repository: RepositoryFixture,
  relativePath: string,
  content: string,
): Promise<string> {
  const absolute = path.join(repository.root, ...relativePath.split("/"));
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content, "utf8");
  return absolute;
}

async function commit(
  repository: RepositoryFixture,
  preview: { token: string; confirmationRequirements: string[] },
) {
  return commitDocumentMutation(
    repository.root,
    preview.token,
    preview.confirmationRequirements,
  );
}

describe("Markdown 文档创建与编辑", () => {
  it("预览不落盘，明确确认后才创建中文路径文档", async () => {
    const repository = await fixture();
    const relativePath = "10_圣经/人物/虚构城.md";
    const absolute = path.join(repository.root, ...relativePath.split("/"));

    const preview = await prepareDocumentCreate(repository.root, {
      path: relativePath,
      content: "# 虚构城\n\n虚构地点的介绍。\n",
    });

    await expect(access(absolute)).rejects.toMatchObject({ code: "ENOENT" });
    expect(preview).toMatchObject({
      kind: "create",
      targetPath: relativePath,
      confirmationRequirements: ["confirm-document-create"],
    });
    await commit(repository, preview);
    expect(await readFile(absolute, "utf8")).toContain("虚构城");
  });

  it("不通过文档创建请求隐式创建目录", async () => {
    const repository = await fixture();

    await expect(
      prepareDocumentCreate(repository.root, {
        path: "10_圣经/尚不存在/嵌套文档.md",
        content: "# 嵌套文档\n",
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_PARENT_NOT_FOUND" });
  });

  it("拒绝通过普通文档能力写正文或直接编辑归档", async () => {
    const repository = await fixture();
    const archived = await seed(
      repository,
      "99_归档/历史设定.md",
      "# 历史设定\n",
    );

    await expect(
      prepareDocumentCreate(repository.root, {
        path: "40_正文/卷/v01/章节/ch004.md",
        content: "# 不应创建\n",
      }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/DOCUMENT|AUTHORITY/),
    });
    await expect(
      prepareDocumentEdit(repository.root, {
        path: "99_归档/历史设定.md",
        content: "# 绕过恢复\n",
        expectedHash: sha256(await readFile(archived, "utf8")),
      }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/DOCUMENT|AUTHORITY/),
    });
    expect(await repository.readChapter()).toBe(repository.originalChapter);
    expect(await readFile(archived, "utf8")).toBe("# 历史设定\n");
  });

  it("外部编辑和两个标签页并发预览都不会丢失更新", async () => {
    const repository = await fixture();
    const relativePath = "10_圣经/人物/主角.md";
    const absolute = path.join(repository.root, ...relativePath.split("/"));
    const before = await readFile(absolute, "utf8");
    const input = {
      path: relativePath,
      content: "# 主角\n\n新版设定。\n",
      expectedHash: sha256(before),
    };
    const [first, second] = await Promise.all([
      prepareDocumentEdit(repository.root, input),
      prepareDocumentEdit(repository.root, {
        ...input,
        content: "# 主角\n\n另一个标签页的版本。\n",
      }),
    ]);

    await commit(repository, first);
    await expect(commit(repository, second)).rejects.toMatchObject({
      code: "MUTATION_CONFLICT",
    });
    expect(await readFile(absolute, "utf8")).toBe(input.content);

    const third = await prepareDocumentEdit(repository.root, {
      path: relativePath,
      content: "# 主角\n\n工作台版本。\n",
      expectedHash: sha256(input.content),
    });
    await writeFile(absolute, "# 主角\n\n外部编辑器修改。\n", "utf8");
    await expect(commit(repository, third)).rejects.toMatchObject({
      code: "MUTATION_CONFLICT",
    });
    expect(await readFile(absolute, "utf8")).toContain("外部编辑器");
  });
});

describe("文档归档、恢复与路径安全", () => {
  it("使用 v3 manifest 保留原始路径和哈希，并可预览恢复", async () => {
    const repository = await fixture();
    const relativePath = "10_圣经/地点/ABC.md";
    const content = "# ABC\n\n待归档设定。\n";
    const absolute = await seed(repository, relativePath, content);
    const archived = await prepareDocumentArchive(repository.root, {
      path: relativePath,
      reason: "设定已替代",
      expectedHash: sha256(content),
    });
    await commit(repository, archived);

    await expect(access(absolute)).rejects.toMatchObject({ code: "ENOENT" });
    const archiveId = archived.archiveId!;
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
      schema_version: 3,
      asset_type: "document",
      original_path: relativePath,
      before_hash: sha256(content),
      authority: "bible",
      restorable: true,
    });
    expect(await listDocumentArchives(repository.root)).toContainEqual(
      expect.objectContaining({ id: archiveId, originalPath: relativePath }),
    );

    const restored = await prepareDocumentRestore(repository.root, {
      archiveId,
    });
    expect(restored).toMatchObject({
      kind: "restore",
      targetPath: relativePath,
    });
    await commit(repository, restored);
    expect(await readFile(absolute, "utf8")).toBe(content);
  });

  it("恢复拒绝 Unicode NFKC 等价目标，不覆盖也不自动改名", async () => {
    const repository = await fixture();
    const relativePath = "10_圣经/地点/ABC.md";
    const content = "# ABC\n";
    await seed(repository, relativePath, content);
    const archived = await prepareDocumentArchive(repository.root, {
      path: relativePath,
      reason: "Unicode 冲突测试",
      expectedHash: sha256(content),
    });
    await commit(repository, archived);
    const conflict = await seed(
      repository,
      "10_圣经/地点/ＡＢＣ.md",
      "# 全角占位\n",
    );

    await expect(
      prepareDocumentRestore(repository.root, {
        archiveId: archived.archiveId!,
      }),
    ).rejects.toMatchObject({ code: "RESTORE_TARGET_OCCUPIED" });
    expect(await readFile(conflict, "utf8")).toBe("# 全角占位\n");
  });

  it("拒绝通过符号链接或 junction 编辑仓库外文档", async () => {
    const repository = await fixture();
    const outside = await mkdtemp(
      path.join(tmpdir(), "novel-document-outside-"),
    );
    outsideDirectories.push(outside);
    await writeFile(path.join(outside, "secret.md"), "# 仓库外\n", "utf8");
    const link = path.join(repository.root, "10_圣经", "外部链接");
    await symlink(
      outside,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      prepareDocumentEdit(repository.root, {
        path: "10_圣经/外部链接/secret.md",
        content: "# 越界写入\n",
        expectedHash: sha256("# 仓库外\n"),
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_DOCUMENT_PATH" });
    expect(await readFile(path.join(outside, "secret.md"), "utf8")).toBe(
      "# 仓库外\n",
    );
  });
});
