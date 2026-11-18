import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import minGit from "./mingit-lock.json" with { type: "json" };

const exec = promisify(execFile);
interface GitProgram {
  source: "system" | "bundled";
  executable: string;
}

// tsx 运行源码 .ts，发布包只运行 tsc 生成的 .js。工作目录和 NODE_ENV 都不改变选择。
const appGit: GitProgram = fileURLToPath(import.meta.url).endsWith(".ts")
  ? { source: "system", executable: "git" }
  : {
      source: "bundled",
      executable: fileURLToPath(
        new URL("../vendor/mingit/cmd/git.exe", import.meta.url),
      ),
    };
const options = { encoding: "utf8", windowsHide: true } as const;

export function validateGitVersion(
  output: string,
  source: GitProgram["source"],
  expectedVersion = minGit.version,
): string {
  const version = output.trim();
  if (source === "bundled") {
    if (version !== `git version ${expectedVersion}`) {
      throw new Error(
        `内置 MinGit 版本不符，需要 ${expectedVersion}，实际为“${version}”。请重新安装完整发布包或重新构建。`,
      );
    }
    return `内置 MinGit ${expectedVersion}`;
  }

  // git init -b（新建小说时指定 main 分支）从 2.28.0 开始支持。
  const match = /^git version (\d+)\.(\d+)\.\d+(?:[.\s+-].*)?$/.exec(version);
  if (
    !match ||
    Number(match[1]) < 2 ||
    (Number(match[1]) === 2 && Number(match[2]) < 28)
  ) {
    throw new Error(
      `开发环境需要 Git 2.28.0 或更高版本，实际为“${version}”。请更新 PATH 中的 Git 后重启。`,
    );
  }
  return `系统 Git ${version.slice("git version ".length)}`;
}

export async function checkGitRuntime(program = appGit): Promise<string> {
  function unavailable(cause: unknown): never {
    const hint =
      program.source === "system"
        ? "无法运行系统 Git。请安装 Git 2.28.0 或更高版本并加入 PATH，重新打开终端后运行 git --version 检查。"
        : `无法运行内置 MinGit（${program.executable}）。请重新安装完整发布包或重新构建。`;
    throw new Error(hint, { cause });
  }
  let expectedVersion = minGit.version;
  if (program.source === "bundled") {
    // 由实际随包的启动程序识别架构。官方 ia32 的版本字符串包含 .dirty。
    const launcher = await readFile(program.executable).catch(unavailable);
    const digest = createHash("sha256").update(launcher).digest("hex");
    const asset = Object.values(minGit.archives).find(
      (item) => item.launcherSha256 === digest,
    );
    if (!asset)
      throw new Error(
        "内置 MinGit 启动程序校验失败。请重新安装完整发布包或重新构建。",
      );
    expectedVersion = asset.gitVersion;
  }
  const { stdout } = await exec(program.executable, ["--version"], {
    ...options,
    timeout: 10_000,
  }).catch(unavailable);
  return validateGitVersion(stdout, program.source, expectedVersion);
}

export async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await exec(
    appGit.executable,
    ["-C", root, "-c", "core.quotepath=false", ...args],
    options,
  );
  // porcelain 状态行的前导空格是索引状态，只去除行尾换行。
  return stdout.replace(/\r?\n$/, "");
}
