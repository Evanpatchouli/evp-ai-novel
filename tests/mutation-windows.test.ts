import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { createMutationEngine } from "../server/mutations/index.js";
import type { RepositoryFixture } from "./helpers/repository-fixture.js";
import { createRepositoryFixture } from "./helpers/repository-fixture.js";

const fixtures: RepositoryFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function holdExclusiveWindowsLock(
  target: string,
): Promise<ChildProcessWithoutNullStreams> {
  const script = `
$ErrorActionPreference = 'Stop'
$stream = [System.IO.File]::Open(
  $env:LOCK_TARGET,
  [System.IO.FileMode]::Open,
  [System.IO.FileAccess]::ReadWrite,
  [System.IO.FileShare]::None
)
try {
  [Console]::Out.WriteLine('READY')
  [Console]::Out.Flush()
  $line = [Console]::In.ReadLine()
  if ($line -ne 'RELEASE') { throw 'unexpected handshake' }
} finally {
  $stream.Dispose()
}`;
  const child = spawn(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: { ...process.env, LOCK_TARGET: target },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const lines = createInterface({ input: child.stdout });
  const [line] = await once(lines, "line", {
    signal: AbortSignal.timeout(5_000),
  });
  lines.close();
  expect(line).toBe("READY");
  return child;
}

async function releaseWindowsLock(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (child.exitCode !== null) return;
  child.stdin.end("RELEASE\n");
  const [code] = await once(child, "exit", {
    signal: AbortSignal.timeout(5_000),
  });
  expect(code).toBe(0);
}

describe("Windows 文件占用恢复", () => {
  it.skipIf(process.platform !== "win32")(
    "目标被 FileShare.None 独占时拒绝写入且必须重新预览",
    async () => {
      const fixture = await createRepositoryFixture();
      fixtures.push(fixture);
      const engine = createMutationEngine();
      const replacement = "# 第二章 待验收\n\n释放占用后的新正文。\n";
      const ticket = await engine.prepareMutation(fixture.root, {
        kind: "windows-exclusive-lock",
        operations: [
          {
            kind: "replace",
            path: "40_正文/卷/v01/章节/ch002.md",
            content: replacement,
          },
        ],
      });
      const child = await holdExclusiveWindowsLock(fixture.chapterPath);
      try {
        await expect(
          engine.commitMutation(fixture.root, ticket.token),
        ).rejects.toBeDefined();
      } finally {
        await releaseWindowsLock(child);
      }

      expect(await fixture.readChapter()).toBe(fixture.originalChapter);
      await expect(
        engine.commitMutation(fixture.root, ticket.token),
      ).rejects.toMatchObject({ code: "INVALID_PREVIEW_TOKEN" });
      await expect(
        readFile(path.join(fixture.root, ".workbench", "write.lock")),
      ).rejects.toMatchObject({ code: "ENOENT" });

      const retry = await engine.prepareMutation(fixture.root, {
        kind: "windows-exclusive-lock-retry",
        operations: [
          {
            kind: "replace",
            path: "40_正文/卷/v01/章节/ch002.md",
            content: replacement,
          },
        ],
      });
      await engine.commitMutation(fixture.root, retry.token);
      expect(await fixture.readChapter()).toBe(replacement);
    },
    20_000,
  );
});
