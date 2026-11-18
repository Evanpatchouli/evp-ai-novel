import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { checkGitRuntime, validateGitVersion } from "../server/git-runtime.js";
import minGit from "../server/mingit-lock.json" with { type: "json" };

it("正式版要求完整的 Git for Windows 构建号", () => {
  expect(
    validateGitVersion(`git version ${minGit.version}\r\n`, "bundled"),
  ).toContain(minGit.version);
  expect(() =>
    validateGitVersion(`git version ${minGit.version}0`, "bundled"),
  ).toThrow("内置 MinGit 版本不符");
  const ia32 = minGit.archives.ia32.gitVersion;
  expect(validateGitVersion(`git version ${ia32}`, "bundled", ia32)).toBe(
    `内置 MinGit ${ia32}`,
  );
  const x64 = minGit.archives.x64.gitVersion;
  expect(() =>
    validateGitVersion(`git version ${x64}.dirty`, "bundled", x64),
  ).toThrow("内置 MinGit 版本不符");
});

it("发布包缺失时报告修复方式，即使 PATH 中已有可用的 Git", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "workbench-incomplete-"));
  try {
    await expect(
      checkGitRuntime({
        source: "bundled",
        executable: path.join(directory, "cmd", "git.exe"),
      }),
    ).rejects.toThrow(/无法运行内置 MinGit.*重新安装完整发布包/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("开发版接受支持 init -b 的系统版本并拒绝过旧或无效的输出", () => {
  for (const version of [
    "2.28.0",
    "2.39.5 (Apple Git-154)",
    "2.50.1.windows.1",
    "3.0.0",
  ]) {
    expect(validateGitVersion(`git version ${version}`, "system")).toContain(
      version,
    );
  }
  for (const version of ["2.9.5", "2.27.9", "1.99.0", "unknown"]) {
    expect(() =>
      validateGitVersion(`git version ${version}`, "system"),
    ).toThrow("2.28.0");
  }
});

it("源码启动找不到 Git 时退出并提示如何修复 PATH", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "workbench-no-git-"));
  try {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => key.toUpperCase() !== "PATH",
      ),
    );
    const entry = fileURLToPath(new URL("../server/index.ts", import.meta.url));
    const result = promisify(execFile)(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), entry],
      {
        cwd: directory,
        env: { ...env, PATH: directory, APPDATA: directory, PORT: "0" },
        timeout: 8_000,
        windowsHide: true,
      },
    );
    await expect(result).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/安装 Git 2\.28\.0.*PATH/),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
