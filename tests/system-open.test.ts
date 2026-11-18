import { EventEmitter } from "node:events";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { openExternal } from "../server/system.js";
import type { RepositoryFixture } from "./helpers/repository-fixture.js";
import { createRepositoryFixture } from "./helpers/repository-fixture.js";

const fixtures: RepositoryFixture[] = [];

afterEach(async () => {
  spawnMock.mockReset();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

function spawnedChild(event: "spawn" | "error", error?: Error) {
  const child = new EventEmitter() as EventEmitter & {
    unref: ReturnType<typeof vi.fn>;
  };
  child.unref = vi.fn();
  spawnMock.mockImplementation(() => {
    queueMicrotask(() => child.emit(event, error));
    return child;
  });
  return child;
}

describe("Windows 外部打开", () => {
  it("folder 对文件取父目录并直接启动可见 explorer.exe", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const child = spawnedChild("spawn");

    await openExternal(fixture.root, "40_正文/卷/v01/章节/ch002.md", "folder");

    expect(spawnMock).toHaveBeenCalledWith(
      "explorer.exe",
      [path.dirname(fixture.chapterPath)],
      expect.objectContaining({
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      }),
    );
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it.each([["default" as const, "40_正文/卷/v01/章节/ch002.md"]])(
    "%s 使用 Start-Process -FilePath 并等待 spawn",
    async (target, relativePath) => {
      const fixture = await createRepositoryFixture();
      fixtures.push(fixture);
      const child = spawnedChild("spawn");

      await openExternal(fixture.root, relativePath, target);

      expect(spawnMock).toHaveBeenCalledWith(
        "powershell.exe",
        expect.arrayContaining(["Start-Process -FilePath $args[0]"]),
        expect.objectContaining({ detached: true, stdio: "ignore" }),
      );
      expect(child.unref).toHaveBeenCalledOnce();
    },
  );

  it("子进程启动失败时拒绝请求且不调用 unref", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const child = spawnedChild("error", new Error("模拟进程启动失败"));

    await expect(
      openExternal(fixture.root, "40_正文/卷/v01/章节/ch002.md", "default"),
    ).rejects.toThrow("模拟进程启动失败");
    expect(child.unref).not.toHaveBeenCalled();
  });
});
