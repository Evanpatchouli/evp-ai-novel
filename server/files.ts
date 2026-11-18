import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppError } from "./errors.js";

export const UTF8 = "utf8" as const;

/** 将仓库相对路径解析为安全绝对路径，拒绝目录穿越。 */
export function resolveInside(root: string, relativePath: string): string {
  const lexicalRoot = path.resolve(root);
  const absolute = path.resolve(lexicalRoot, relativePath);
  const lexicalPrefix = `${lexicalRoot}${path.sep}`;
  if (absolute !== lexicalRoot && !absolute.startsWith(lexicalPrefix)) {
    throw new AppError("PATH_OUTSIDE_REPOSITORY", "路径超出小说仓库", 400, {
      relativePath,
    });
  }

  // realpath 可阻止仓库内 junction/symlink 指向仓库外。对于尚未创建的写入
  // 目标，验证最近的已存在父目录，确保后续 mkdir/write 不会越界。
  const realRoot = realpathSync.native(lexicalRoot);
  let existing = absolute;
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const realExisting = realpathSync.native(existing);
  const normalize = (value: string) =>
    process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
  const normalizedRoot = normalize(realRoot);
  const normalizedExisting = normalize(realExisting);
  if (
    normalizedExisting !== normalizedRoot &&
    !normalizedExisting.startsWith(`${normalizedRoot}${path.sep}`)
  ) {
    throw new AppError(
      "PATH_OUTSIDE_REPOSITORY",
      "路径通过符号链接指向仓库外",
      400,
      { relativePath },
    );
  }
  return absolute;
}

export function relativeSlash(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join("/");
}

export function sha256(content: string | Uint8Array): string {
  const hash = createHash("sha256");
  if (typeof content === "string") hash.update(content, UTF8);
  else hash.update(content);
  return hash.digest("hex");
}

/** 同目录临时文件替换，避免留下半写文件。 */
export async function atomicWrite(
  target: string,
  content: string | Uint8Array,
): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID()}.tmp`,
  );
  try {
    if (typeof content === "string")
      await writeFile(temporary, content, { encoding: UTF8, flag: "wx" });
    else await writeFile(temporary, content, { flag: "wx" });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function readUtf8(file: string): Promise<string> {
  return readFile(file, UTF8);
}
