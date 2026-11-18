import { spawn } from "node:child_process";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { assert } from "./errors.js";
import { resolveInside } from "./files.js";

/** 通过 Windows Shell 打开文件或目录。 */
export async function openExternal(
  root: string,
  relativePath: string,
  target: "default" | "folder",
): Promise<void> {
  const absolute = resolveInside(root, relativePath);
  await access(absolute);
  let openTarget =
    target === "folder" && (await stat(absolute)).isFile()
      ? path.dirname(absolute)
      : absolute;
  assert(
    process.platform === "win32",
    "UNSUPPORTED_PLATFORM",
    "当前仅实现 Windows 外部打开",
  );
  const command = target === "folder" ? "explorer.exe" : "powershell.exe";
  const args =
    target === "folder"
      ? [openTarget]
      : [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Start-Process -FilePath $args[0]",
          openTarget,
        ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: target !== "folder",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
