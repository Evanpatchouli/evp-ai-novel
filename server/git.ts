import { AppError } from "./errors.js";
import { git } from "./git-runtime.js";
import { withRepositoryWriteGuard } from "./mutations/index.js";
import type { GitStatusSummary } from "../shared/contracts.js";

/** 只读获取 Git 状态；不会执行任何改变仓库的命令。 */
export async function getGitStatus(root: string): Promise<GitStatusSummary> {
  try {
    const [branch, porcelain, lastCommit, counts] = await Promise.all([
      git(root, ["branch", "--show-current"]),
      git(root, ["status", "--porcelain=v1", "-uall"]),
      git(root, ["log", "-1", "--format=%aI%x09%s"]).catch(() => ""),
      git(root, [
        "rev-list",
        "--left-right",
        "--count",
        "HEAD...@{upstream}",
      ]).catch(() => "0\t0"),
    ]);
    const changes = porcelain
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const rawPath = line.slice(3).replace(/^"|"$/g, "");
        const changedPath = rawPath.includes(" -> ")
          ? rawPath.split(" -> ").at(-1)!
          : rawPath;
        return {
          code: line.slice(0, 2),
          path: changedPath,
          generatedRisk: /(^|\/)(build|dist|node_modules)\//i.test(changedPath),
        };
      });
    const [behind = 0, ahead = 0] = counts.split(/\s+/).map(Number);
    const [lastCommitAt, ...subject] = lastCommit.split("\t");
    const plainLanguage =
      changes.length === 0
        ? ["工作区没有未提交修改。"]
        : [`有 ${changes.length} 个文件尚未保存到 Git 历史。`];
    if (ahead) plainLanguage.push(`当前分支领先远端 ${ahead} 个提交。`);
    if (behind)
      plainLanguage.push(`当前分支落后远端 ${behind} 个提交，请先人工检查。`);
    if (changes.some((item) => item.generatedRisk))
      plainLanguage.push("检测到生成目录变更，提交前请确认未误入仓库。");
    return {
      branch: branch || "(detached HEAD)",
      clean: changes.length === 0,
      ahead,
      behind,
      lastCommitAt,
      lastCommitSubject: subject.join("\t"),
      changes,
      plainLanguage,
      suggestedCommitMessage: "正文: 完成人工终稿验收",
      suggestedCommands: [
        "git status --short",
        "git diff --check",
        "git diff",
        "git add <确认后的文件>",
        "git commit",
      ],
    };
  } catch (error) {
    return {
      branch: "未知",
      clean: false,
      ahead: 0,
      behind: 0,
      changes: [],
      plainLanguage: [
        `无法读取 Git 状态：${error instanceof Error ? error.message : String(error)}`,
      ],
      suggestedCommitMessage: "正文: 完成人工终稿验收",
      suggestedCommands: ["git status --short"],
    };
  }
}

export interface NovelVersion { id: string; date: string; message: string }

export async function listNovelVersions(root: string): Promise<NovelVersion[]> {
  const head = await git(root, ["rev-parse", "--verify", "HEAD"]).catch(() => "");
  if (!head) return [];
  const output = await git(root, ["log", "-100", "--format=%H%x09%aI%x09%s"]);
  return output.split("\n").filter(Boolean).map((line) => {
    const [id = "", date = "", ...message] = line.split("\t");
    return { id, date, message: message.join("\t") };
  });
}

export async function createNovelVersion(root: string, message: string): Promise<NovelVersion> {
  return withRepositoryWriteGuard(root, "git-snapshot", async () => {
    await git(root, ["add", "-A", "--", "."]);
    const changes = await git(root, ["diff", "--cached", "--name-only"]);
    if (!changes) throw new AppError("NO_VERSION_CHANGES", "没有需要保存的新变化", 409);
    await git(root, ["-c", "user.name=evp-ai-novel", "-c", "user.email=local@evp-ai-novel", "commit", "-m", message]);
    return (await listNovelVersions(root))[0]!;
  });
}
