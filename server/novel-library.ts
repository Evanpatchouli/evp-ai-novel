import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { AppError } from "./errors.js";
import { git } from "./git-runtime.js";
import { readNovelMetadata } from "./novel-metadata.js";

const ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export interface ManagedNovel {
  id: string;
  title: string;
}

export class NovelLibrary {
  readonly novelsRoot: string;
  private readonly selectionFile: string;
  constructor(
    dataRoot = path.join(
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "evp-ai-novel",
    ),
  ) {
    this.novelsRoot = path.join(dataRoot, "novels");
    this.selectionFile = path.join(dataRoot, "selected-novel.json");
  }
  async ensure(): Promise<void> {
    await mkdir(this.novelsRoot, { recursive: true });
  }
  async resolve(id: string): Promise<string> {
    if (!ID.test(id))
      throw new AppError("INVALID_NOVEL_ID", "小说 ID 无效", 400);
    const root = path.join(this.novelsRoot, id);
    try {
      const info = await lstat(root);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("invalid directory");
      const parent = await realpath(this.novelsRoot);
      if (path.dirname(await realpath(root)) !== parent)
        throw new Error("outside library");
    } catch {
      throw new AppError("NOVEL_NOT_FOUND", "小说不存在或目录不安全", 404);
    }
    return root;
  }
  async list(): Promise<ManagedNovel[]> {
    await this.ensure();
    const entries = await readdir(this.novelsRoot, { withFileTypes: true });
    const items: ManagedNovel[] = [];
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        !ID.test(entry.name)
      )
        continue;
      const root = await this.resolve(entry.name);
      try {
        const detail = await readNovelMetadata(root);
        if (detail.exists && detail.metadata.novel.id === entry.name)
          items.push({ id: entry.name, title: detail.metadata.novel.title });
      } catch {
        /* Ignore malformed entries instead of reading outside the library. */
      }
    }
    return items.sort(
      (a, b) =>
        a.title.localeCompare(b.title, "zh-CN") || a.id.localeCompare(b.id),
    );
  }
  async selected(): Promise<string | undefined> {
    try {
      const value: unknown = JSON.parse(
        await readFile(this.selectionFile, "utf8"),
      );
      if (
        typeof value === "string" &&
        (await this.list()).some((item) => item.id === value)
      )
        return value;
    } catch {
      /* First run or invalid selection. */
    }
    return (await this.list())[0]?.id;
  }
  async select(id: string): Promise<string> {
    const root = await this.resolve(id);
    if (!(await this.list()).some((item) => item.id === id))
      throw new AppError("NOVEL_NOT_FOUND", "小说不存在", 404);
    await this.saveSelection(id);
    return root;
  }
  async saveSelection(id?: string): Promise<void> {
    await writeFile(this.selectionFile, JSON.stringify(id ?? null), "utf8");
  }
  async remove(id: string): Promise<string | undefined> {
    const root = await this.resolve(id);
    const detail = await readNovelMetadata(root);
    if (!detail.exists || detail.metadata.novel.id !== id) {
      throw new AppError("NOVEL_NOT_FOUND", "小说不在工作台书库中", 404);
    }

    // Rename before purging so a partial filesystem failure cannot leave a broken novel in the library.
    const directory = await mkdtemp(
      path.join(await realpath(this.novelsRoot), ".deleting-"),
    );
    const target = path.join(directory, id);
    try {
      await rename(root, target);
    } catch (error) {
      await rmdir(directory).catch(() => undefined);
      throw error;
    }

    try {
      const info = await lstat(target);
      if (
        info.isSymbolicLink() ||
        !info.isDirectory() ||
        path.dirname(await realpath(target)) !== directory
      ) {
        return target;
      }
      await rm(target, { recursive: true, force: false, maxRetries: 3 });
    } catch {
      return target;
    }
    await rmdir(directory).catch(() => undefined);
  }
  async create(
    title: string,
    author: string,
    description: string,
  ): Promise<ManagedNovel> {
    await this.ensure();
    const id = randomUUID();
    const root = path.join(this.novelsRoot, id);
    await mkdir(root);
    try {
      const directories = [
        "00_项目",
        "10_圣经/核心",
        "10_圣经/人物",
        "20_规划/卷",
        "30_生产/active",
        "40_正文/卷",
        "50_审稿/逐章",
        "60_发布",
        "70_素材",
        "99_归档/工作台回收站",
      ];
      await Promise.all(
        directories.map((name) =>
          mkdir(path.join(root, name), { recursive: true }),
        ),
      );
      await writeFile(
        path.join(root, "00_项目", "小说.yaml"),
        yaml.dump(
          { schema_version: 1, novel: { id, title, author, description } },
          { noRefs: true },
        ),
        "utf8",
      );
      await writeFile(path.join(root, ".gitignore"), ".workbench/\n", "utf8");
      await git(root, ["init", "-b", "main"]);
      return { id, title };
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }
}
