import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import unzipper from "unzipper";
import { checkGitRuntime } from "../server/git-runtime.js";
import lock from "../server/mingit-lock.json" with { type: "json" };

const project = path.resolve(import.meta.dirname, "..");
const cache = path.join(project, "output", "mingit-cache");
const vendor = path.join(project, "dist", "vendor");
const release = "https://github.com/git-for-windows/git/releases";
const tag = `v${lock.version}`;

async function readArchive(
  asset: { file: string; sha256: string },
  staging: string,
) {
  const archivePath = path.join(cache, asset.file);
  let bytes: Buffer;
  let downloaded = false;
  try {
    bytes = await readFile(archivePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const url = `${release}/download/${tag}/${asset.file}`;
    console.log(`下载 ${url}`);
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok)
      throw new Error(`下载 ${asset.file} 失败（HTTP ${response.status}）。`);
    bytes = Buffer.from(await response.arrayBuffer());
    downloaded = true;
  }
  if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
    throw new Error(
      `${asset.file} 的 SHA-256 与锁定值不一致。请从官方发布页重新获取压缩包并检查 ${archivePath}。`,
    );
  }
  if (downloaded) {
    const temporary = path.join(staging, asset.file);
    await writeFile(temporary, bytes);
    await rename(temporary, archivePath);
  }
  return unzipper.Open.buffer(bytes);
}

async function componentLicenses(directory: string, arch: string) {
  const inventory = await readFile(
    path.join(directory, "etc", "package-versions.txt"),
    "utf8",
  );
  const packages = new Set(inventory.trim().split(/\r?\n/));
  const review = await readFile(
    path.join(project, "third-party", "mingit", arch + ".txt"),
    "utf8",
  );
  const reviewed = new Set(
    review
      .split(/\r?\n/)
      .filter((line) => /^[^#\t]+\t\S/.test(line))
      .map((line) => line.split("\t")[0]),
  );
  const missing = [...packages].filter((pkg) => !reviewed.has(pkg));
  if (missing.length || packages.size !== reviewed.size) {
    throw new Error(
      `请按 MinGit 组件清单更新 ${arch} 的许可证记录。待核对组件：${missing.join(", ") || "清单中有已移除的组件"}。`,
    );
  }
  return review;
}

async function writeNotices(
  directory: string,
  archive: unzipper.CentralDirectory,
  file: string,
  arch: string,
) {
  const notices = archive.files.filter(
    (entry) =>
      entry.type === "File" &&
      (entry.path.includes("/share/licenses/") ||
        /(?:^|\/)(?:licen[cs]e|copying|copyright|notice|authors)(?:\.|$)/i.test(
          entry.path,
        )),
  );
  const paths = notices.map((entry) => entry.path).sort();
  const packages = archive.files.find(
    (entry) => entry.path === "etc/package-versions.txt",
  );
  if (
    !packages ||
    !paths.includes("LICENSE.txt") ||
    !paths.some((p) => p.startsWith("usr/share/licenses/")) ||
    !paths.some((p) => p.endsWith("/git-credential-manager/NOTICE"))
  ) {
    throw new Error(
      "MinGit 组件清单、许可证或版权声明不完整，请核对上游分发包。",
    );
  }
  // 对照已校验的原始 ZIP 逐字节核对，包括许可证目录中命名为 README 等的声明。
  for (const entry of [packages, ...notices]) {
    const installed = await readFile(path.join(directory, entry.path));
    if (!installed.length || !installed.equals(await entry.buffer())) {
      throw new Error(`分发目录中的 ${entry.path} 与上游原文不符。`);
    }
  }
  const review = await componentLicenses(directory, arch);
  await copyFile(
    path.join(project, "third-party", "mingit", "additional-notices.txt"),
    path.join(directory, "additional-notices.txt"),
  );
  await writeFile(
    path.join(directory, "THIRD-PARTY-NOTICES.txt"),
    [
      `MinGit for Windows ${lock.version} (${file})`,
      `${release}/tag/${tag}`,
      "Git 使用 GNU GPL v2。随附组件各自的许可证和版权声明见以下原始文件。",
      "additional-notices.txt 收录了 Heimdal、libcbor、libfido2 等组件的补充版权声明及来源。",
      "组件版本见 etc/package-versions.txt。可使用 Git for Windows SDK 的 get-sources.sh --mingit 按此清单获取对应源码。",
      "https://github.com/git-for-windows/build-extra/blob/main/get-sources.sh",
      "",
      ...paths,
      "",
      review,
    ].join("\n"),
  );
  console.log(`已核对 MinGit 组件清单和 ${paths.length} 份声明文件。`);
}

async function installBundle(staging: string) {
  const destination = path.join(vendor, "mingit");
  const previous = staging + "-previous";
  let replaced = false;
  try {
    await rename(destination, previous);
    replaced = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await rename(staging, destination);
  } catch (error) {
    if (replaced) await rename(previous, destination);
    throw error;
  }
  if (replaced) await rm(previous, { recursive: true, force: true });
}

async function bundle() {
  const arch = process.arch;
  if (!(arch in lock.archives))
    throw new Error(`没有适用于 ${arch} 的 MinGit 分发包。`);
  const asset = lock.archives[arch as keyof typeof lock.archives];
  await Promise.all([
    mkdir(vendor, { recursive: true }),
    mkdir(cache, { recursive: true }),
  ]);
  const staging = await mkdtemp(path.join(cache, "bundle-"));
  try {
    const archive = await readArchive(asset, staging);
    await archive.extract({ path: staging, concurrency: 8 });
    await writeNotices(staging, archive, asset.file, arch);
    if (process.platform === "win32") {
      await checkGitRuntime({
        source: "bundled",
        executable: path.join(staging, "cmd", "git.exe"),
      });
    }
    await installBundle(staging);
    console.log(`已打包 MinGit ${lock.version}（${arch}）。`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

await bundle();
