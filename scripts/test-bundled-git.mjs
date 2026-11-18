import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkGitRuntime } from "../dist/server/git-runtime.js";
import {
  createNovelVersion,
  getGitStatus,
  listNovelVersions,
} from "../dist/server/git.js";
import { NovelLibrary } from "../dist/server/novel-library.js";

if (process.platform === "win32") {
  const directory = await mkdtemp(path.join(tmpdir(), "工作台 MinGit-"));
  try {
    // 使用临时书库和独立 Git 配置，模拟没有安装 Git 的 Windows 用户。
    for (const name of Object.keys(process.env)) {
      if (name.toUpperCase().startsWith("GIT_")) delete process.env[name];
    }
    process.env.PATH = "";
    process.env.GIT_CONFIG_GLOBAL = path.join(directory, "gitconfig");
    const version = await checkGitRuntime();
    const library = new NovelLibrary(directory);
    const novel = await library.create("测试小说", "作者", "");
    const root = await library.resolve(novel.id);
    assert.equal((await getGitStatus(root)).branch, "main");
    assert.deepEqual(await listNovelVersions(root), []);
    const saved = await createNovelVersion(root, "中文版本记录");
    assert.equal(saved.message, "中文版本记录");
    assert.deepEqual(await listNovelVersions(root), [saved]);
    assert.equal((await getGitStatus(root)).clean, true);
    console.log(`${version} 已在空 PATH 下通过建库、保存和历史读取测试。`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
} else {
  console.log("MinGit 的运行测试需要在目标架构的 Windows 上执行。");
}
